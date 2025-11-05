// Carga la librería dotenv para leer nuestro archivo .env
require('dotenv').config();

module.exports = {
  apps : [{
    name   : "api-mrfrio",
    script : "./server.js",
    watch: true,
    ignore_watch: ["node_modules"],
    // En lugar de 'env_file', definimos las variables directamente.
    // El 'require('dotenv').config()' de arriba ya las cargó en process.env
    env: {
      "NODE_ENV": "production",
      "SUPABASE_URL": process.env.SUPABASE_URL,
      "SUPABASE_SERVICE_KEY": process.env.SUPABASE_SERVICE_KEY,
      "STRIPE_SECRET_KEY": process.env.STRIPE_SECRET_KEY,
      "STRIPE_WEBHOOK_SECRET": process.env.STRIPE_WEBHOOK_SECRET,
      "RESEND_API_KEY": process.env.RESEND_API_KEY,
      "TURNSTILE_SECRET_KEY": process.env.TURNSTILE_SECRET_KEY,
      "ADMIN_SECRET_KEY": process.env.ADMIN_SECRET_KEY,
      "PORT": process.env.PORT || 3000
    }
  }]
}
