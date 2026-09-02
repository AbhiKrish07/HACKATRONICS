import kagglehub
from kagglehub import KaggleDatasetAdapter

df = kagglehub.load_dataset(
  KaggleDatasetAdapter.PANDAS,
  "fedesoriano/traffic-prediction-dataset",
  "traffic.csv"
)

print(df.head())
print(df.info())
