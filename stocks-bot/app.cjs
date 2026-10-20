'use strict';

import('./app.js').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
