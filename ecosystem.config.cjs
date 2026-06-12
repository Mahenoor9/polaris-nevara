/**
 * ecosystem.config.cjs
 * ─────────────────────────────────────────────────────────────────────────────
 * PM2 Process Manager Configuration for EC2 deployment.
 * Manages the Node.js API server with automatic restart, log rotation,
 * and clustering.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup
 *
 * Status:  pm2 status
 * Logs:    pm2 logs nevara-api
 * Reload:  pm2 reload nevara-api (zero-downtime)
 * ─────────────────────────────────────────────────────────────────────────────
 */

module.exports = {
  apps: [
    {
      name: "nevara-api",
      script: "./dist/index.js",
      instances: 1, // Single instance — upgrade to "max" when Redis SSE pub/sub is implemented
      exec_mode: "fork", // Use "cluster" when multi-instance is ready
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 3000,
      max_restarts: 10, // Stop trying after 10 consecutive crashes (prevents crash loops)
      min_uptime: "10s", // Must stay up 10s to count as successful start

      env: {
        NODE_ENV: "production",
        PORT: 5000,
      },

      // Log configuration
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "/var/log/nevara/api-out.log",
      error_file: "/var/log/nevara/api-error.log",
      merge_logs: true,

      // Graceful shutdown
      kill_timeout: 10000, // 10s for in-flight requests to complete
      listen_timeout: 30000, // Wait up to 30s for the process to go online

      // Health/readiness
      post_update: ["npm run build"], // Run after `pm2 deploy` update
    },
  ],
};
