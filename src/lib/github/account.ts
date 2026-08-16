import { ObjectId } from "mongodb";
import getMongoClient from "@/lib/mongodb";

/** Reads the GitHub numeric account id linked to an Auth.js user via the adapter's `accounts` collection. */
export async function getGithubAccountId(userId: string): Promise<string | null> {
  const client = await getMongoClient();
  const db = client.db(process.env.MONGODB_DB);
  const account = await db
    .collection<{ userId: ObjectId; provider: string; providerAccountId: string }>("accounts")
    .findOne({ userId: new ObjectId(userId), provider: "github" });

  return account?.providerAccountId ?? null;
}
