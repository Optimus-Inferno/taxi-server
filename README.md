# Taxi Server

Backend for the Taxi app connecting passengers and drivers.

## Local Development

```bash
cd server
npm install
node index.js
```

## Deployment (Railway / Render)

1. Push this folder to GitHub
2. Connect to Railway or Render
3. Set start command: `node index.js`
4. Deploy
5. Update the app's API URL in `src/lib/api.ts`

## API Endpoints

- `POST /api/drivers/online` - Driver goes online/offline
- `POST /api/drivers/location` - Update driver location
- `POST /api/rides/request` - Passenger requests ride
- `POST /api/rides/accept` - Driver accepts ride
- `POST /api/rides/complete` - Complete ride

## WebSocket Events

- `ride_request` - Sent to drivers when a passenger requests
- `ride_accepted` - Sent to passenger when driver accepts
- `driver_location` - Real-time driver location updates
- `ride_completed` - Ride completion notification
