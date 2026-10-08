// SPDX-License-Identifier: GPL-3.0-only
// Starts the server and shuts it down cleanly when the app that launched it goes away.

const path = require('node:path');

process.stdin.on('end', () => {
    // The server's SIGTERM handler stops FFmpeg; before it is installed there is nothing to clean up.
    if (!process.emit('SIGTERM')) process.exit(0);
});
process.stdin.resume();
require(path.resolve(process.argv[2]));
