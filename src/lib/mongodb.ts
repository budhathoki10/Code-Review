import { MongoClient } from "mongodb";

declare global {
  var _mongoClientPromise: Promise<MongoClient> | undefined;
}

function connect(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("Missing MONGODB_URI environment variable");
  }
  return new MongoClient(uri).connect();
}

let clientPromise: Promise<MongoClient> | undefined;

/**
 * Lazily resolves a shared MongoClient connection. Deferred (rather than
 * connecting at module load) so build-time module evaluation — which
 * imports this file without real env vars available — doesn't crash.
 */
export default function getMongoClient(): Promise<MongoClient> {
  if (process.env.NODE_ENV === "development") {
    // Cache across HMR reloads in dev so we don't open a new connection on
    // every module reload.
    if (!global._mongoClientPromise) {
      global._mongoClientPromise = connect();
    }
    return global._mongoClientPromise;
  }
  if (!clientPromise) {
    clientPromise = connect();
  }
  return clientPromise;
}
