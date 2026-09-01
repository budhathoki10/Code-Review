import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { MongoDBAdapter } from "@auth/mongodb-adapter";
import getMongoClient from "@/lib/mongodb";
import { rememberGithubLogin } from "@/lib/github/account";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(getMongoClient, { databaseName: process.env.MONGODB_DB }),
  providers: [GitHub],
  session: { strategy: "database" },
  // Auth.js's built-in error screen is a dead end; ours explains the one
  // error this app can actually produce (a GitHub account already claimed by
  // another workspace) and offers a way back.
  pages: { error: "/auth/error" },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    /**
     * Runs after the account has been created or linked, so the document this
     * writes to always exists by now. The raw OAuth profile is the only place
     * the GitHub login appears — the adapter drops it — and it is what the
     * connect menu names each linked account by.
     */
    async signIn({ account, profile }) {
      if (account?.provider !== "github") return;
      const login = (profile as { login?: unknown } | undefined)?.login;
      if (typeof login === "string" && login) {
        await rememberGithubLogin(account.providerAccountId, login);
      }
    },
  },
});
