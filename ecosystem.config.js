// ecosystem.config.js
module.exports = {
    apps: [
        {
            name: 'apex-gateway',           // App name in PM2
            script: 'dist/main.js',        // Entry file path
            instances: 'max',             // Use all CPU cores (cluster mode)
            exec_mode: 'cluster',         // Enable load balancing
            autorestart: true,            // Auto-restart if app crashes
            watch: false,                 // Disable file watching in production
            max_memory_restart: '1G',     // Restart if memory exceeds 1GB
            env: {
                NODE_ENV: 'production',     // Set environment variables
                PORT: 3000,                 // Optional: set port here
            },
        },
    ],
};