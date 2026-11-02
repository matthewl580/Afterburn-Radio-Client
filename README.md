# Afterburn Radio

The Express server serves the public radio page at `/` and the protected
station controls at `/admin`. The stream URL is `/stream`.

## Setup

1. Install Node.js 20 or newer and run `npm install`.
2. In Firebase, enable **Authentication → Email/Password** and create the
   account you will use to sign in to `/admin`.
3. Set these environment variables on the server:
   - `FIREBASE_SERVICE_KEY_JSON`: the Firebase Admin service-account JSON.
   - `FIREBASE_WEB_CONFIG_JSON`: the Firebase web app config JSON (`apiKey`,
     `authDomain`, `projectId`, `appId`, and optionally `storageBucket`).
   - `ADMIN_UID`: the Firebase Authentication UID allowed to administer the
     station. Other signed-in Firebase users cannot manage the station.
   - `PORT`: optional; defaults to `3000`.
4. Ensure the service account can read and write objects in the
   `afterburn-radio.firebasestorage.app` Firebase Storage bucket.
5. Run `npm start`.

The web app config is public Firebase client configuration; never put the
service-account key in the browser. The server verifies Firebase ID tokens for
song uploads, edits, deletions, queue changes, and live-broadcast connections.
Reading the track list and listening to `/stream` remain public.

The admin uploader accepts MP3 files so Auto-DJ tracks and the live microphone
feed share the same MP3 stream format. Microphone access requires HTTPS (or
localhost) and browser permission.

Track metadata and queue order are saved to `radio-state.json` in Firebase
Storage. Uploaded audio is stored under `tracks/`.
