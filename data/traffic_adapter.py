import os
import time
import threading
import logging
from typing import Optional, Dict, Any

try:
    import pandas as pd
    import kagglehub # type: ignore
    from kagglehub import KaggleDatasetAdapter # type: ignore
except ImportError:
    pd = None
    kagglehub = None

logger = logging.getLogger("av01.traffic_adapter")

class TrafficDatasetAdapter:
    """
    Loads and serves the fedesoriano/traffic-prediction-dataset.
    Maps simulation time to real-world dataset hours to control traffic density.
    """
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(TrafficDatasetAdapter, cls).__new__(cls)
                cls._instance._df = None
                cls._instance._loaded = False
                cls._instance._start_time = time.time()
                cls._instance._load_in_background()
            return cls._instance

    def _load_in_background(self):
        if not kagglehub or not pd:
            logger.warning("kagglehub or pandas not installed. Traffic volume defaults to 50.")
            return

        def task():
            try:
                logger.info("Downloading fedesoriano/traffic-prediction-dataset...")
                df = kagglehub.dataset_load(
                    KaggleDatasetAdapter.PANDAS,
                    "fedesoriano/traffic-prediction-dataset",
                    "traffic.csv"
                )
                
                # Sort by DateTime
                df['DateTime'] = pd.to_datetime(df['DateTime'])
                df = df.sort_values(by='DateTime')
                
                # Use Junction 1 for baseline density
                self._df = df[df['Junction'] == 1].copy()
                self._loaded = True
                logger.info(f"Traffic dataset loaded: {len(self._df)} records.")
            except Exception as e:
                logger.error(f"Failed to load traffic dataset: {e}")
        
        threading.Thread(target=task, daemon=True).start()

    def get_current_density(self) -> Dict[str, Any]:
        """
        Calculates the current traffic volume.
        1 real second = 1 hour in the dataset to simulate passing time rapidly.
        """
        if not self._loaded or self._df is None:
            return {"vehicles": 15, "datetime": "N/A", "status": "loading"}
            
        elapsed_sec = time.time() - self._start_time
        # Loop over the dataset if we run out (48k records)
        idx = int(elapsed_sec) % len(self._df)
        
        row = self._df.iloc[idx]
        return {
            "vehicles": int(row["Vehicles"]),
            "datetime": str(row["DateTime"]),
            "status": "active"
        }

# Global singleton
traffic_adapter = TrafficDatasetAdapter()
