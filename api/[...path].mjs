import apiHandler from "../server/api-handler.mjs";

// Vercel's Node.js runtime supports the standard Web Request/Response handler.
// Use the Vercel-only backend implementation.
export default {
  async fetch(request) {
    return apiHandler(request);
  },
};
