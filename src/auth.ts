//“Allow GitHub login, save users and sessions in MongoDB, and include each user’s database ID in their session.”

import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
// MongoDBAdapter: saves users, accounts, and sessions in MongoDB.
import { MongoDBAdapter } from "@auth/mongodb-adapter";
//getMongoClient connects this project to MongoDB.
import getMongoClient from "@/lib/mongodb";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(getMongoClient, { databaseName: process.env.MONGODB_DB }),
  providers: [GitHub],
  
  session: { strategy: "database" },
  callbacks: {
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
});
