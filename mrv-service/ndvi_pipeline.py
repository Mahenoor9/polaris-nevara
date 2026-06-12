import ee
import json
import logging
from datetime import datetime, timedelta
from typing import List, Dict, Optional
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings

# Configure logging for production visibility
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class NDVIPipeline:
    """Fetch NDVI data from Google Earth Engine with production-grade reliability."""
    
    def __init__(self) -> None:
        self.initialized = False
        self._authenticate()

    def _authenticate(self):
        """Handle GEE authentication using multiple credential sources."""
        try:
            # Order of preference: 
            # 1. JSON string from environment (e.g. for CI/CD, Secrets Manager)
            # 2. File path from environment
            # 3. Default auth (if running locally with gcloud auth)
            
            if settings.GEE_PRIVATE_KEY_JSON:
                logger.info("Attempting GEE auth via JSON string...")
                key_data = json.loads(settings.GEE_PRIVATE_KEY_JSON)
                credentials = ee.ServiceAccountCredentials(settings.GEE_SERVICE_ACCOUNT, key_data=json.dumps(key_data))
                ee.Initialize(credentials, project=settings.GEE_PROJECT_ID)
            elif settings.GEE_PRIVATE_KEY_FILE:
                logger.info(f"Attempting GEE auth via file: {settings.GEE_PRIVATE_KEY_FILE}")
                credentials = ee.ServiceAccountCredentials(settings.GEE_SERVICE_ACCOUNT, settings.GEE_PRIVATE_KEY_FILE)
                ee.Initialize(credentials, project=settings.GEE_PROJECT_ID)
            else:
                # Try default initialization (useful for local dev with 'earthengine authenticate')
                logger.info("Attempting GEE default initialization...")
                ee.Initialize(project=settings.GEE_PROJECT_ID)
            
            self.initialized = True
            logger.info("✅ Google Earth Engine initialized successfully")
        except Exception as e:
            logger.error(f"❌ GEE Initialization failed: {str(e)}")
            logger.warning("Pipeline will operate in MOCK MODE.")
            self.initialized = False

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10))
    def fetch_monthly_ndvi(self, polygon_geojson: Dict) -> List[Dict]:
        """Fetch NDVI data from Sentinel-2 with retry logic and mock fallback."""
        if not self.initialized or not polygon_geojson:
            return self._get_mock_data(polygon_geojson)

        try:
            logger.info(f"Fetching GEE NDVI data for polygon...")
            
            # Ensure coordinates are in correct format for ee.Geometry
            # Expecting a standard GeoJSON Polygon or Feature
            if 'geometry' in polygon_geojson:
                polygon_geojson = polygon_geojson['geometry']
            
            geom = ee.Geometry(polygon_geojson)
            
            # Define time range: 24 exact calendar months
            end_date = datetime.utcnow()
            start_month = end_date.month - 24
            start_year = end_date.year
            while start_month <= 0:
                start_month += 12
                start_year -= 1
            start_date = datetime(start_year, start_month, 1)
            
            # Load Sentinel-2 Surface Reflectance (Harmonized)
            # We use harmonized to handle the Sentinel-2 transition in 2022
            collection = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED") \
                .filterBounds(geom) \
                .filterDate(start_date.strftime('%Y-%m-%d'), end_date.strftime('%Y-%m-%d')) \
                .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))

            def calculate_ndvi(image):
                ndvi = image.normalizedDifference(['B8', 'B4']).rename('NDVI')
                return image.addBands(ndvi).copyProperties(image, ['system:time_start'])

            with_ndvi = collection.map(calculate_ndvi)

            results = []
            for i in range(24):
                # Calculate precise month start and end
                current_month_total = start_date.month - 1 + i
                y = start_date.year + current_month_total // 12
                m = current_month_total % 12 + 1
                m_start = datetime(y, m, 1)
                
                next_month_total = current_month_total + 1
                ny = start_date.year + next_month_total // 12
                nm = next_month_total % 12 + 1
                m_end = datetime(ny, nm, 1)
                
                # Filter for the specific month
                month_coll = with_ndvi.filterDate(
                    m_start.strftime('%Y-%m-%d'), 
                    m_end.strftime('%Y-%m-%d')
                )
                
                # Take the median (reduces noise/cloud artifacts)
                monthly_img = month_coll.median()
                
                try:
                    # Reduce region to get mean NDVI
                    stats = monthly_img.select('NDVI').reduceRegion(
                        reducer=ee.Reducer.mean(),
                        geometry=geom,
                        scale=10,
                        maxPixels=1e9
                    ).getInfo()
                    
                    if stats and 'NDVI' in stats and stats['NDVI'] is not None:
                        results.append({
                            'month': m_start.strftime('%Y-%m'),
                            'ndvi_mean': round(float(stats['NDVI']), 4),
                            'cloud_cover_pct': 10.0, # Approximate for valid pixels
                            'is_real': True
                        })
                    else:
                        # Gap fill if no data for month
                        prev_val = results[-1]['ndvi_mean'] if results else 0.5
                        results.append({
                            'month': m_start.strftime('%Y-%m'),
                            'ndvi_mean': prev_val,
                            'cloud_cover_pct': 100.0,
                            'gap_filled': True
                        })
                except Exception as inner_e:
                    logger.warning(f"Month {m_start.strftime('%Y-%m')} fetch failed: {inner_e}")
                    results.append({
                        'month': m_start.strftime('%Y-%m'),
                        'ndvi_mean': results[-1]['ndvi_mean'] if results else 0.5,
                        'cloud_cover_pct': 100.0,
                        'error': True
                    })

            logger.info(f"Successfully fetched {len(results)} months of NDVI data")
            return results

        except Exception as e:
            logger.error(f"Critical GEE error: {e}. Falling back to mock data.")
            return self._get_mock_data(polygon_geojson)

    def _get_mock_data(self, polygon_geojson: Dict) -> List[Dict]:
        """Fallback deterministic mock data for reliability."""
        logger.info("Generating deterministic mock NDVI data...")
        try:
            poly_str = json.dumps(polygon_geojson, sort_keys=True)
            base = sum(ord(c) for c in poly_str) % 1000
        except:
            base = 500
            
        results = []
        today = datetime.utcnow()
        
        start_month = today.month - 24
        start_year = today.year
        while start_month <= 0:
            start_month += 12
            start_year -= 1

        for i in range(24):
            # 24 exact calendar months in chronological order
            current_month_total = start_month - 1 + i
            y = start_year + current_month_total // 12
            m = current_month_total % 12 + 1
            month_date = datetime(y, m, 1)
            month_str = month_date.strftime('%Y-%m')
            # Simulated seasonal variance + project health
            ndvi_mean = 0.65 + ((base + i) % 30) / 200.0 
            results.append({
                'month': month_str,
                'ndvi_mean': round(ndvi_mean, 4),
                'cloud_cover_pct': round(15.0 + (i % 10), 2),
                'is_mock': True
            })
        return results
