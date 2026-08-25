import "./env.js";
import { InfluxDB, Point } from '@influxdata/influxdb-client';

const url = process.env.INFLUX_URL;
const token = process.env.INFLUX_TOKEN;
const org = process.env.INFLUX_ORG;
const bucket = process.env.INFLUX_BUCKET;

// Explicit transport timeout. The library default (10 s) was in force implicitly; naming
// it means a hung InfluxDB cannot silently hold an ingest path open, and it can be tuned
// without editing code. Every write path awaits flush() (see the architecture audit A-05),
// so this bounds how long an agent POST can block on a stalled InfluxDB.
const client = new InfluxDB({
  url,
  token,
  timeout: Number(process.env.INFLUX_TIMEOUT_MS) || 10_000,
});

const writeClient = client.getWriteApi(org, bucket, "ms");
const queryClient = client.getQueryApi(org);

// Export
export { writeClient, queryClient, Point, bucket };



