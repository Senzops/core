// Constants for Byte Conversions
const GB = 1024 * 1024 * 1024;

export type PlanId = 'starter' | 'pro' | 'business' | 'enterprise';

export interface PlanConfig {
  id: PlanId;
  name: string;
  priceMonthly: number;
  priceAnnual: number;
  maxServicesPerType: number;
  maxIngestionBytes: number;
  maxOrganizations: number;
  retentionDays: number;
  aiAnalysis: boolean;
  aiAnalysisMonthlyQuota: number;  // 0 = disabled, -1 = unlimited
  paddlePriceIdMonthly: string | null;
  paddlePriceIdAnnual: string | null;
  dodoProductIdMonthly: string | null;
  dodoProductIdAnnual: string | null;
}

export const PLANS: Record<PlanId, PlanConfig> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 0,
    priceAnnual: 0,
    maxServicesPerType: 1,
    maxIngestionBytes: 2 * GB,
    maxOrganizations: 1,
    retentionDays: 3,
    aiAnalysis: false,
    aiAnalysisMonthlyQuota: 0,
    paddlePriceIdMonthly: null,
    paddlePriceIdAnnual: null,
    dodoProductIdMonthly: null,
    dodoProductIdAnnual: null,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 29,
    priceAnnual: 278, // ~$23/mo (20% off)
    maxServicesPerType: 5,
    maxIngestionBytes: 15 * GB,
    maxOrganizations: 3,
    retentionDays: 15,
    aiAnalysis: false,
    aiAnalysisMonthlyQuota: 0,
    paddlePriceIdMonthly: 'pri_01knfdyzk9gsjwfh4vq3hfg2q0',
    paddlePriceIdAnnual: 'pri_01knfe0d96abaf790xead78y0m',
    dodoProductIdMonthly: 'pdt_0NfOCqR7Jh4KxjWipmxdi',
    dodoProductIdAnnual: 'pdt_0NfOCqHOShtUikkTy0h87',
  },
  business: {
    id: 'business',
    name: 'Business',
    priceMonthly: 99,
    priceAnnual: 950, // ~$79/mo (20% off)
    maxServicesPerType: 99999,
    maxIngestionBytes: 100 * GB,
    maxOrganizations: 10,
    retentionDays: 30,
    aiAnalysis: true,
    aiAnalysisMonthlyQuota: 500,
    paddlePriceIdMonthly: 'pri_01knfe2b0s6yycykn1y4x2mrrk',
    paddlePriceIdAnnual: 'pri_01knfe3g8941dyr18vvy9tc2qy',
    dodoProductIdMonthly: 'pdt_0NfOCpyjpqRvf5QvCdVqn',
    dodoProductIdAnnual: 'pdt_0NfOCpozTewfGT6bjez95',
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthly: -1,
    priceAnnual: -1,
    maxServicesPerType: 99999,
    maxIngestionBytes: 1000 * GB,
    maxOrganizations: 99999,
    retentionDays: 90,
    aiAnalysis: true,
    aiAnalysisMonthlyQuota: -1,  // Unlimited
    paddlePriceIdMonthly: null,
    paddlePriceIdAnnual: null,
    dodoProductIdMonthly: null,
    dodoProductIdAnnual: null,
  }
};

export const getPlanConfig = (planId?: string): PlanConfig => {
  return PLANS[(planId as PlanId)] || PLANS.starter;
};