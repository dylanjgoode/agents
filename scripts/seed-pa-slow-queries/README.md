# Performance Advisor slow-query seeder

Use this to create data and run slow queries for MongoDB Atlas Performance Advisor. It drops and recreates the `highImpact` database, loads collections that scan a lot of data, then runs unindexed finds so Performance Advisor has high-impact examples to recommend indexes for.

Requires `mongosh` on PATH.

```bash
./seed.sh "mongodb+srv://USERNAME:PASSWORD@cluster0.xxxxx.mongodb.net/"
```

A URI with embedded credentials is supported; do not pass a second argument in that case.

Copy `.env.example` to `.env` and set `MONGODB_URI`, then `./seed.sh` with no args.
