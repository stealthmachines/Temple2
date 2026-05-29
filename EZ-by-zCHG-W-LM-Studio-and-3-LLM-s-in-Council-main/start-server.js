// Server startup wrapper to bypass ESM cache corruption
// This avoids the duplicate function error by using CommonJS-style import

import('./server.js').then(module => {
  console.log('[START] Server module loaded successfully');

  // Start the server once the module is loaded
  if (module.createServer) {
    const server = module.createServer({});
    const transport = new SSEServerTransport('http://localhost:4111/sse', '/sse');

    server.use('/sse', (req, res) => {
      transport.reqHandler(req, res);
    });

    server.on('error', err => console.error('[SERVER ERROR]', err));

    const port = parseInt(process.env.MCP_PORT || '4111');
    server.listen(port, '127.0.0.1', () => {
      console.log(`[SUCCESS] Server running on http://localhost:${port}/sse`);
    });
  }
}).catch(err => {
  console.error('[ERROR] Failed to load server:', err.message);
  console.error('Try running: npm reinstall');
  process.exit(1);
});

// Fallback: direct require if import fails
if (typeof require !== 'undefined') {
  try {
    const Module = require('module');
    const originalResolve = Module._resolve;
    Module._resolve = function(id, ...) {
      if (id === './server.js') return originalResolve(id, ...);
      return originalResolve(id, ...);
    };
  } catch(e) {}
}