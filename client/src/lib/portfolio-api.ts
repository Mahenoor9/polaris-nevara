export interface PortfolioOverview {
  totalProjects: number;
  totalAreaHa: number;
  avgHealthScore: number;
  underReview: number;
  monitoringRuns: number;
  evidencePackages: number;
  totalCO2: number;
}

export interface EcosystemDistributionItem {
  ecosystem: string;
  count: number;
  areaHa: number;
  percentage: number;
}

export interface PortfolioRankingItem {
  id: string;
  name: string;
  ecosystemType: string;
  trustScore: number;
  ndviDeltaPct: number | null;
  areaHa: number | null;
}

export interface AtRiskItem {
  id: string;
  name: string;
  ecosystemType: string;
  trustScore: number;
  status: string;
  mrvStatus: string | null;
  redFlag: boolean;
}

export interface PortfolioRankings {
  topPerformers: PortfolioRankingItem[];
  atRisk: AtRiskItem[];
  mostImproved: PortfolioRankingItem[];
}

export interface PortfolioAlert {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  projectId: string;
  projectName: string;
  message: string;
}

export interface PortfolioInsight {
  type: string;
  text: string;
}

export interface GeoFeature {
  id: string;
  name: string;
  ecosystemType: string;
  status: string;
  areaHa: number | null;
  trustScore: number | null;
  boundary: Array<{ lat: number; lng: number }>;
}

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('bluecarbon_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchPortfolio<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: getAuthHeaders() });
  if (!res.ok) throw new Error(`Portfolio API error: ${res.status}`);
  return res.json();
}

export const portfolioApi = {
  getOverview: () => fetchPortfolio<PortfolioOverview>('/api/portfolio/overview'),
  getEcosystemDistribution: () => fetchPortfolio<{ distribution: EcosystemDistributionItem[]; totalArea: number }>('/api/portfolio/ecosystem-distribution'),
  getRankings: () => fetchPortfolio<PortfolioRankings>('/api/portfolio/rankings'),
  getAlerts: () => fetchPortfolio<{ alerts: PortfolioAlert[]; count: number }>('/api/portfolio/alerts'),
  getInsights: () => fetchPortfolio<{ insights: PortfolioInsight[] }>('/api/portfolio/insights'),
  getProjectsGeo: () => fetchPortfolio<{ features: GeoFeature[] }>('/api/portfolio/projects-geo'),
};
