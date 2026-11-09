import apiHandler from "../server/api-handler.mjs";

export default {
  async fetch(request) {
    return apiHandler(request);
  },
};