import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Web Bluetooth requires a secure context. This lets you test over HTTPS
    // on your phone using a tool like `npx vite --host` + a tunnel (e.g. ngrok),
    // or just deploy and test on the real HTTPS URL.
    host: true,
  },
});
