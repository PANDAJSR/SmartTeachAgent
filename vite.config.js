const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react");

module.exports = defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
