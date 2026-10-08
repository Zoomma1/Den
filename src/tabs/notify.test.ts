import { describe, it, expect } from "vitest";
import { notificationFor } from "./notify";

describe("notificationFor", () => {
  it("notifie le passage en waiting avec le nom du projet", () => {
    expect(notificationFor("running", "waiting", "den")).toEqual({
      title: "den",
      body: "Needs your input",
    });
  });

  it("notifie la fin d'un tour (running|waiting -> idle)", () => {
    expect(notificationFor("running", "idle", "den")).toEqual({ title: "den", body: "Finished" });
    expect(notificationFor("waiting", "idle", "den")).toEqual({ title: "den", body: "Finished" });
  });

  it("ne notifie pas les autres transitions", () => {
    expect(notificationFor("idle", "running", "den")).toBeNull();
    expect(notificationFor("waiting", "running", "den")).toBeNull();
    expect(notificationFor("running", "error", "den")).toBeNull();
    expect(notificationFor("idle", "idle", "den")).toBeNull();
    expect(notificationFor("waiting", "waiting", "den")).toBeNull();
    expect(notificationFor(undefined, "idle", "den")).toBeNull();
    expect(notificationFor("running", "closed", "den")).toBeNull();
  });
});
