const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "Taxi server running" });
});

const drivers = new Map();
const activeRides = new Map();
const waitingPassengers = new Map();
const rejectedPassengers = new Map();
const passengerViolations = new Map(); // passengerId -> count
const CANCEL_GRACE_PERIOD_MS = 10 * 1000; // 10 seconds (TEMP FOR TESTING)
const MAX_VIOLATIONS = 3;

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getAvailableDrivers() {
  return Array.from(drivers.values())
    .filter(d => d.isOnline && d.isAvailable)
    .map(d => ({ driverId: d.id, location: d.location, rank: d.rank, route: d.route }));
}

function getWaitingPassengersForDriver(driverId) {
  const rejected = rejectedPassengers.get(driverId) || new Set();
  return Array.from(waitingPassengers.values())
    .filter(p => p.status === "waiting")
    .filter(p => !rejected.has(p.passengerId));
}

function broadcastState() {
  const availableDrivers = getAvailableDrivers();
  io.emit("available_drivers", availableDrivers);

  for (const [driverId] of drivers) {
    const passengersForThisDriver = getWaitingPassengersForDriver(driverId);
    io.emit("waiting_passengers_for_driver", { driverId, passengers: passengersForThisDriver });
  }

  io.emit("waiting_passengers", Array.from(waitingPassengers.values()).filter(p => p.status === "waiting"));
}

app.post("/api/drivers/register", (req, res) => {
  const { driverId, rank, route, routePath, direction } = req.body;
  drivers.set(driverId, {
    id: driverId, isOnline: false, isAvailable: false, location: null,
    rank: rank || "Unknown", route: route || "Unknown",
    routePath: routePath || [], direction: direction || "unknown",
  });
  rejectedPassengers.set(driverId, new Set());
  res.json({ success: true, driver: drivers.get(driverId) });
});

app.post("/api/drivers/online", (req, res) => {
  const { driverId, isOnline, location } = req.body;
  if (!drivers.has(driverId)) {
    drivers.set(driverId, { id: driverId, isOnline: false, isAvailable: false, location: null, rank: "Unknown", route: "Unknown", routePath: [], direction: "unknown" });
    rejectedPassengers.set(driverId, new Set());
  }
  const driver = drivers.get(driverId);
  driver.isOnline = isOnline;
  driver.isAvailable = isOnline;
  if (location) driver.location = location;
  broadcastState();
  res.json({ success: true, driver });
});

app.post("/api/passengers/signal", (req, res) => {
  const { passengerId, pickup, destination, fare } = req.body;
  const violationCount = passengerViolations.get(passengerId) || 0;
  if (violationCount >= MAX_VIOLATIONS) {
    return res.status(403).json({
      error: "Booking temporarily blocked due to repeated late cancellations",
      violationCount,
      maxViolations: MAX_VIOLATIONS,
    });
  }
  waitingPassengers.set(passengerId, {
    passengerId, pickup, destination, fare: fare || null,
    timestamp: Date.now(), status: "waiting",
  });
  broadcastState();
  res.json({ success: true, waitingCount: waitingPassengers.size });
});

app.post("/api/passengers/cancel", (req, res) => {
  const { passengerId } = req.body;
  if (passengerId) {
    waitingPassengers.delete(passengerId);
    broadcastState();
    res.json({ success: true, waitingCount: waitingPassengers.size });
  } else {
    res.status(400).json({ error: "passengerId required" });
  }
});

// RIDE LIFECYCLE ENDPOINTS

app.post("/api/rides/accept", (req, res) => {
  const { rideId, driverId, passengerId } = req.body;
  if (passengerId) waitingPassengers.delete(passengerId);

  const ride = {
    id: rideId || `ride-${Date.now()}`,
    passengerId, driverId,
    status: "accepted", // driver found, en route to passenger
    createdAt: Date.now(),
  };
  activeRides.set(ride.id, ride);
  io.emit("ride_accepted", { rideId: ride.id, driverId, passengerId, status: "accepted" });
  broadcastState();
  res.json({ success: true, ride });
});

app.post("/api/rides/arrive", (req, res) => {
  const { rideId } = req.body;
  const ride = activeRides.get(rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.status = "driver_arrived";
  io.emit("ride_status_update", { rideId, status: "driver_arrived" });
  res.json({ success: true, ride });
});

app.post("/api/rides/start", (req, res) => {
  const { rideId } = req.body;
  const ride = activeRides.get(rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.status = "in_progress";
  io.emit("ride_status_update", { rideId, status: "in_progress" });
  res.json({ success: true, ride });
});

app.post("/api/rides/complete", (req, res) => {
  const { rideId } = req.body;
  const ride = activeRides.get(rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  ride.status = "completed";
  if (drivers.has(ride.driverId)) {
    drivers.get(ride.driverId).isAvailable = true;
  }
  io.emit("ride_status_update", { rideId, status: "completed" });
  broadcastState();
  res.json({ success: true, ride });
});

app.post("/api/rides/cancel-active", (req, res) => {
  const { rideId } = req.body;
  const ride = activeRides.get(rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });
  const statusBeforeCancel = ride.status;
  ride.status = "cancelled";
  if (drivers.has(ride.driverId)) {
    drivers.get(ride.driverId).isAvailable = true;
  }

  const elapsed = Date.now() - (ride.createdAt || Date.now());
  const lateStage = ["driver_arrived", "in_progress"].includes(statusBeforeCancel);
  let violationCount = passengerViolations.get(ride.passengerId) || 0;
  let penalized = false;
  if (elapsed > CANCEL_GRACE_PERIOD_MS || lateStage) {
    violationCount += 1;
    passengerViolations.set(ride.passengerId, violationCount);
    penalized = true;
  }

  io.emit("ride_cancelled", { rideId, passengerId: ride.passengerId });
  broadcastState();
  res.json({ success: true, ride, penalized, violationCount, maxViolations: MAX_VIOLATIONS });
});

app.post("/api/rides/reject", (req, res) => {
  const { passengerId, driverId } = req.body;
  if (!rejectedPassengers.has(driverId)) rejectedPassengers.set(driverId, new Set());
  rejectedPassengers.get(driverId).add(passengerId);
  broadcastState();
  res.json({ success: true, message: "Passenger rejected" });
});

app.post("/api/debug/clear", (req, res) => {
  waitingPassengers.clear();
  drivers.clear();
  broadcastState();
  res.json({ success: true, message: "State cleared" });
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.emit("available_drivers", getAvailableDrivers());
  socket.emit("waiting_passengers", Array.from(waitingPassengers.values()).filter(p => p.status === "waiting"));

  socket.on("request_state", () => {
    socket.emit("available_drivers", getAvailableDrivers());
    socket.emit("waiting_passengers", Array.from(waitingPassengers.values()).filter(p => p.status === "waiting"));
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Taxi server running on port ${PORT}`);
});
