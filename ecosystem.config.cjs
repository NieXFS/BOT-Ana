module.exports = {
  apps: [
    {
      name: 'receps-ia',
      cwd: __dirname,
      script: 'dist/webhookServer.js',
      instances: 1,
      exec_mode: 'fork',
      // Give the runtime time to drain active HTTP requests after it has
      // cancelled maintenance timers. The server has its own 25s deadline;
      // PM2 is the final 5s safety net before SIGKILL.
      kill_timeout: 30_000,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        TZ: 'America/Sao_Paulo',
        // Este processo combinado atende HTTP e é a única instância elegível
        // para as recuperações. Réplicas web devem usar PROCESS_ROLE=web e
        // RUN_MAINTENANCE_WORKERS=false.
        PROCESS_ROLE: 'worker',
      },
    },
  ],
};
