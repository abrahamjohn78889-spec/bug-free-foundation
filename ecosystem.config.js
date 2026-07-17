// PM2 process manager daemon rules for continuous VPS deployment.
//
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 save                      # persist the process list
//   pm2 startup                   # generate the boot script (VPS reboot recovery)
//
// Recovery model:
//   • crash / OOM        → PM2 restarts (exponential backoff, see below)
//   • VPS reboot         → pm2 startup + pm2 save resurrect the process
//   • engine re-ignition → the app auto-resumes ignition from its own kv
//                          state ("engine:running"), so no manual start is
//                          needed after any restart
//   • graceful shutdown  → SIGINT is trapped in instrumentation.ts, which
//                          disposes the engine (timers, sockets, feeds)
//                          within kill_timeout
module.exports = {
  apps: [
    {
      name: 'edge5',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3000',
      cwd: __dirname,
      instances: 1, // single instance: the engine holds in-memory order state
      exec_mode: 'fork',

      // --- restart policy ---
      autorestart: true,
      // Exponential backoff between restarts (150ms → 15s max) so a hard
      // boot-crash loop cannot spin the CPU or hammer external APIs.
      exp_backoff_restart_delay: 150,
      // A process that dies within 10s of boot counts as an unstable start.
      min_uptime: '10s',
      // Give up after 50 unstable restarts in a row (alert-worthy state;
      // normal crashes reset the counter once uptime exceeds min_uptime).
      max_restarts: 50,
      // Memory ceiling: restart before a leak can take down the whole VPS.
      max_memory_restart: '512M',

      // --- graceful shutdown ---
      // SIGINT → instrumentation.ts disposes the engine (cancels timers,
      // closes WebSockets, stops feeds); PM2 force-kills only after 8s.
      kill_timeout: 8000,

      env: {
        NODE_ENV: 'production',
      },

      // --- logs ---
      out_file: 'logs/edge5.out.log',
      error_file: 'logs/edge5.err.log',
      merge_logs: true,
      time: true,
      // NOTE: install pm2-logrotate on the VPS so log files stay bounded:
      //   pm2 install pm2-logrotate
      //   pm2 set pm2-logrotate:max_size 20M
      //   pm2 set pm2-logrotate:retain 14
      //   pm2 set pm2-logrotate:compress true
    },
  ],
}
