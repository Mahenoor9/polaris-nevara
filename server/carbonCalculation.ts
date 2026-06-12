/**
 * Carbon Sequestration Calculation Module
 * 
 * Calculates annual and lifetime CO₂ sequestration based on:
 * - Area (hectares)
 * - Ecosystem type
 * - Location/Region
 */

// Sequestration rates (tons CO₂ per hectare per year)
// Keys match ECOSYSTEM_TYPES in shared/schema.ts.
// Legacy short-name aliases kept for backward compatibility with existing DB rows.
const SEQUESTRATION_RATES: Record<string, number> = {
  // Current canonical names
  'Mangrove Forest':        8.0,
  'Seagrass Meadow':        5.5,
  'Salt Marsh':             4.5,
  'Coastal Wetland':        3.5,
  'Freshwater Wetland':     3.0,
  'Lake Restoration':       1.5,
  'River Restoration':      2.0,
  'Forest Restoration':     6.0,
  'Agricultural Regeneration': 2.5,
  'Mixed Ecosystem':        4.0,
  'Other / Unknown':        2.0,
  // Legacy aliases (pre-expansion short names stored in existing projects)
  'Mangrove':               8.0,
  'Seagrass':               5.5,
  'Coastal':                3.5,
  'Other':                  2.0,
};

// Regional adjustment factors
const REGIONAL_FACTORS: Record<string, number> = {
  'Tropical': 1.2,
  'Temperate': 0.8,
  'Default': 1.0,
};

/**
 * Determines regional factor based on location string
 */
function getRegionalFactor(location: string): number {
  const locationLower = location.toLowerCase();
  
  // Check for tropical keywords
  const tropicalKeywords = ['tropical', 'equator', 'caribbean', 'pacific islands', 'indonesia', 'thailand', 'malaysia', 'philippines', 'hawaii', 'fiji', 'brazil', 'amazon', 'costa rica', 'panama', 'vietnam', 'india', 'africa', 'kenya', 'tanzania', 'madagascar'];
  if (tropicalKeywords.some(keyword => locationLower.includes(keyword))) {
    return REGIONAL_FACTORS['Tropical'];
  }
  
  // Check for temperate keywords
  const temperateKeywords = ['temperate', 'europe', 'north america', 'canada', 'usa', 'united states', 'uk', 'britain', 'france', 'germany', 'japan', 'korea', 'china', 'australia', 'new zealand', 'argentina', 'chile'];
  if (temperateKeywords.some(keyword => locationLower.includes(keyword))) {
    return REGIONAL_FACTORS['Temperate'];
  }
  
  // Default factor
  return REGIONAL_FACTORS['Default'];
}

/**
 * Calculate carbon sequestration
 * 
 * Formula: CO₂/year = A × B × C
 * Where:
 * - A = area (hectares)
 * - B = sequestration rate (depends on ecosystem type)
 * - C = regional adjustment factor
 * 
 * Lifetime CO₂ = Annual CO₂ × 20 years
 */
export function calculateCarbonSequestration(
  area: number,
  ecosystemType: string,
  location: string
): { annualCO2: number; lifetimeCO2: number } {
  // Get sequestration rate (B)
  const sequestrationRate = SEQUESTRATION_RATES[ecosystemType] ?? SEQUESTRATION_RATES['Other / Unknown'] ?? 2.0;
  
  // Get regional factor (C)
  const regionalFactor = getRegionalFactor(location);
  
  // Calculate annual CO₂ sequestration: A × B × C
  const annualCO2 = area * sequestrationRate * regionalFactor;
  
  // Calculate lifetime CO₂ (20 years)
  const lifetimeCO2 = annualCO2 * 20;
  
  return {
    annualCO2: Math.round(annualCO2 * 100) / 100, // Round to 2 decimal places
    lifetimeCO2: Math.round(lifetimeCO2 * 100) / 100,
  };
}
