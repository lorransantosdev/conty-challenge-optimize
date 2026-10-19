import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type PageRow = { id: string; name: string; niche_score: number; latest_reach: number; deliveries_90d: number };
type CountRow = { n: number };

// Score, alcance e ordem são calculados no SQL, então o custo em queries não
// depende de quantos criadores existem: campanha, total e a página.
const PAGE_SQL = `
WITH scored AS (
  SELECT c.id, c.name, COUNT(*) AS niche_score
  FROM creators c, json_each(c.niches_json) cn
  JOIN json_each(?) campaign ON campaign.value = cn.value
  GROUP BY c.id
),
latest AS (
  SELECT account_id, views,
    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY captured_at DESC, id DESC) AS rn
  FROM metrics
),
reach AS (
  SELECT a.creator_id, SUM(l.views) AS latest_reach
  FROM social_accounts a
  JOIN latest l ON l.account_id = a.id AND l.rn = 1
  GROUP BY a.creator_id
),
page AS (
  SELECT s.id, s.name, s.niche_score, COALESCE(r.latest_reach, 0) AS latest_reach
  FROM scored s
  LEFT JOIN reach r ON r.creator_id = s.id
  ORDER BY s.niche_score DESC, latest_reach DESC, s.id ASC
  LIMIT ? OFFSET ?
)
SELECT p.id, p.name, p.niche_score, p.latest_reach,
  (SELECT COUNT(*) FROM deliveries d WHERE d.creator_id = p.id AND d.delivered_at >= ?) AS deliveries_90d
FROM page p
ORDER BY p.niche_score DESC, p.latest_reach DESC, p.id ASC
`;

const TOTAL_SQL = `
SELECT COUNT(*) AS n
FROM creators c
WHERE EXISTS (
  SELECT 1 FROM json_each(c.niches_json) cn
  JOIN json_each(?) campaign ON campaign.value = cn.value
)
`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(db, "SELECT id, niches_json FROM campaigns WHERE id = ?", input.campaignId);
  if (!campaign) return null;

  const total = await get<CountRow>(db, TOTAL_SQL, campaign.niches_json);
  const rows = await all<PageRow>(
    db,
    PAGE_SQL,
    campaign.niches_json,
    input.limit,
    input.offset,
    deliveriesSince(),
  );

  return {
    campaign_id: input.campaignId,
    total: Number(total?.n ?? 0),
    creators: rows.map((row) => ({
      id: row.id,
      name: row.name,
      niche_score: Number(row.niche_score),
      latest_reach: Number(row.latest_reach),
      deliveries_90d: Number(row.deliveries_90d),
    })),
  };
}
