import supertest from "supertest";
import { DEV_TOKEN } from "./security.js";

/** Exercise the real access middleware in existing integration tests. */
export default function request(app: Parameters<typeof supertest>[0]) {
  const client = supertest(app);
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (["get", "post", "put", "patch", "delete", "head", "options"].includes(String(property))) {
        return (...args: unknown[]) => value.apply(target, args).set("x-chiptool-token", DEV_TOKEN);
      }
      return value;
    }
  });
}
