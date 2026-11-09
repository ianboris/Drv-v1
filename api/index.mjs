import apiHandler from "../server/api-handler.mjs";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const routePath = incoming.searchParams.get("__route");
    if (!routePath || !/^[A-Za-z0-9/_-]+$/.test(routePath)) {
      return Response.json({ error: "Invalid API route." }, { status: 400 });
    }
    incoming.pathname = `/api/${routePath.replace(/^\/+/, "")}`;
    incoming.searchParams.delete("__route");
    return apiHandler(new Request(incoming, request));
  },
};
