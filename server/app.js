/* ============================================================
   Passenger entry point (cPanel → Application Manager)
   Phusion Passenger runs THIS file. It just boots the existing
   server, which serves both the /api endpoints AND the static
   site, and listens on the port Passenger provides (process.env.PORT).
   Local development is unchanged — `npm start` still runs server.js.
   ============================================================ */
require('./server.js');
