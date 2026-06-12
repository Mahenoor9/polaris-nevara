from dataclasses import dataclass
import hashlib
import json
from typing import List, Dict

# Ecosystem factors and carbon rates (same as plan)
ECOSYSTEM_FACTORS = {
    'mangrove': 0.90,
    'seagrass': 0.70,
    'saltmarsh': 0.75,
}

ECOSYSTEM_CARBON_RATE = {
    'mangrove': 7.0,
    'seagrass': 3.5,
    'saltmarsh': 4.0,
}

@dataclass
class ScoreResult:
    trust_score: int
    confidence: str
    baseline_ndvi: float
    current_ndvi: float
    ndvi_delta_pct: float
    canopy_pct: float
    ecosystem_factor: float
    area_ha: float
    red_flag: bool
    data_gap_months: int
    credits_estimate: float
    credits_issuable: float
    breakdown: Dict
    input_hash: str
    output_hash: str

class ScoringEngine:
    """Calculate MRV trust score based on NDVI data and project parameters.
    The algorithm follows the IPCC‑based formula described in the implementation plan.
    """
    def _hash(self, obj: Dict) -> str:
        """Create a deterministic SHA‑256 hash of a JSON‑serialisable object."""
        json_str = json.dumps(obj, sort_keys=True).encode('utf-8')
        return hashlib.sha256(json_str).hexdigest()

    def calculate_score(
        self,
        ecosystem_type: str,
        area_ha: float,
        ndvi_data: List[Dict],
        project_age_years: float = 0.0,
    ) -> ScoreResult:
        # Validate ecosystem
        if ecosystem_type not in ECOSYSTEM_FACTORS:
            raise ValueError(f"Unsupported ecosystem_type: {ecosystem_type}")
        factor = ECOSYSTEM_FACTORS[ecosystem_type]
        carbon_rate = ECOSYSTEM_CARBON_RATE[ecosystem_type]

        # NDVI baseline: average of first 6 months
        baseline_vals = [d['ndvi_mean'] for d in ndvi_data[:6]]
        baseline_ndvi = sum(baseline_vals) / len(baseline_vals) if baseline_vals else 0.0

        # Current NDVI: most recent month
        current_ndvi = ndvi_data[-1]['ndvi_mean'] if ndvi_data else 0.0
        ndvi_delta_pct = ((current_ndvi - baseline_ndvi) / baseline_ndvi) * 100 if baseline_ndvi else 0.0

        # Simple canopy estimate from NDVI (linear mapping, placeholder)
        canopy_pct = max(0.0, min(100.0, (current_ndvi - 0.4) * 250))  # Rough estimate

        # Red flag if NDVI drop >15% below baseline
        red_flag = ndvi_delta_pct < -15.0

        # Confidence tier based on data completeness
        data_gap_months = len([d for d in ndvi_data if d.get('gap_filled') or d.get('error')])
        if red_flag:
            confidence = 'LOW'
        elif data_gap_months > 2:
            confidence = 'MEDIUM'
        else:
            confidence = 'HIGH'

        # Credits calculation (core IP formula)
        credits_raw = area_ha * carbon_rate * factor
        credits_estimate = credits_raw
        credits_issuable = credits_raw * 0.80  # 20% buffer deduction

        # Build breakdown for transparency
        breakdown = {
            'ecosystem_factor': factor,
            'carbon_rate': carbon_rate,
            'area_ha': area_ha,
            'credits_raw': credits_raw,
            'buffer_deduction': 0.20,
        }

        # Input hash includes all raw inputs
        input_hash = self._hash({
            'ecosystem_type': ecosystem_type,
            'area_ha': area_ha,
            'ndvi_data': ndvi_data,
            'project_age_years': project_age_years,
        })

        # Output hash includes all derived outputs
        output_hash = self._hash({
            'trust_score': 0,  # placeholder, will be set below
            'confidence': confidence,
            'baseline_ndvi': baseline_ndvi,
            'current_ndvi': current_ndvi,
            'ndvi_delta_pct': ndvi_delta_pct,
            'canopy_pct': canopy_pct,
            'credits_estimate': credits_estimate,
            'credits_issuable': credits_issuable,
        })

        # Trust score: map NDVI delta & canopy to 0‑100 range (simple linear model)
        ndvi_score = max(0, min(100, (ndvi_delta_pct + 20) * 2))  # shift & scale
        canopy_score = max(0, min(100, canopy_pct))
        raw_score = (ndvi_score * 0.6) + (canopy_score * 0.4)
        trust_score = int(round(raw_score))

        # Re‑hash output with final trust_score
        output_hash = self._hash({
            'trust_score': trust_score,
            'confidence': confidence,
            'baseline_ndvi': baseline_ndvi,
            'current_ndvi': current_ndvi,
            'ndvi_delta_pct': ndvi_delta_pct,
            'canopy_pct': canopy_pct,
            'credits_estimate': credits_estimate,
            'credits_issuable': credits_issuable,
        })

        return ScoreResult(
            trust_score=trust_score,
            confidence=confidence,
            baseline_ndvi=baseline_ndvi,
            current_ndvi=current_ndvi,
            ndvi_delta_pct=ndvi_delta_pct,
            canopy_pct=canopy_pct,
            ecosystem_factor=factor,
            area_ha=area_ha,
            red_flag=red_flag,
            data_gap_months=data_gap_months,
            credits_estimate=credits_estimate,
            credits_issuable=credits_issuable,
            breakdown=breakdown,
            input_hash=input_hash,
            output_hash=output_hash,
        )
