module.exports = {
  apps: [
    {
      name: 'receps-ia',
      cwd: __dirname,
      script: 'dist/webhookServer.js',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        TZ: 'America/Sao_Paulo',
      },
    },
  ],
};
