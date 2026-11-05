import netlifyApi from "../netlify/functions/api.mjs";

// Vercel's Node.js runtime supports the standard Web Request/Response handler.
// Keep one API implementation shared between Netlify and Vercel.
export default {
  async fetch(request) {
    return netlifyApi(request);
  },
};
