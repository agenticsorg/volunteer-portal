import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server.js";
import { initEmbedder } from "../src/embedder.js";
import { _resetAllIndexesForTests } from "../src/matcher.js";

beforeAll(async () => {
  await initEmbedder();
}, 30_000);

describe("GET /health", () => {
  it("reports embedder readiness", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", embedderReady: true });
  });
});

describe("POST /index and POST /match", () => {
  it("indexes then matches a realistic query end to end over HTTP", async () => {
    _resetAllIndexesForTests();
    const app = createApp();

    const indexRes = await request(app)
      .post("/index")
      .send({
        collection: "projects",
        items: [
          { id: "p1", text: "Redesign the nonprofit's website using React and Figma" },
          { id: "p2", text: "Build wooden shelters, carpentry and power tools needed" },
        ],
      });
    expect(indexRes.status).toBe(200);
    expect(indexRes.body).toEqual({ collection: "projects", count: 2 });

    const matchRes = await request(app)
      .post("/match")
      .send({ collection: "projects", query: "I know React and Figma", limit: 2 });
    expect(matchRes.status).toBe(200);
    expect(matchRes.body.results[0].id).toBe("p1");
    expect(typeof matchRes.body.results[0].score).toBe("number");
  });

  it("rejects an invalid collection with 400, not a crash", async () => {
    const app = createApp();
    const res = await request(app).post("/match").send({ collection: "not-a-real-collection", query: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing query with 400", async () => {
    const app = createApp();
    const res = await request(app).post("/match").send({ collection: "projects" });
    expect(res.status).toBe(400);
  });

  it("rejects malformed index items with 400", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/index")
      .send({ collection: "projects", items: [{ id: "p1" }] });
    expect(res.status).toBe(400);
  });
});

describe("POST /match-candidates", () => {
  it("ranks a caller-supplied candidate set over HTTP", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/match-candidates")
      .send({
        query: "certified first aid trainer",
        candidates: [
          { id: "a", text: "Teach a community first aid and CPR certification class" },
          { id: "b", text: "Sort donated groceries at the food bank" },
        ],
        limit: 2,
      });
    expect(res.status).toBe(200);
    expect(res.body.results[0].id).toBe("a");
  });

  it("rejects an empty candidates array shape mismatch with 400", async () => {
    const app = createApp();
    const res = await request(app).post("/match-candidates").send({ query: "x", candidates: "not-an-array" });
    expect(res.status).toBe(400);
  });
});
