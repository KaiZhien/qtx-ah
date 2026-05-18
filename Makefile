.PHONY: install ingest clean-data phenotype outcomes features eda model dashboard all test clean

install:
	pip install -e .

ingest:
	python scripts/01_ingest.py

clean-data:
	python scripts/02_clean.py

phenotype:
	python scripts/03_phenotype.py

outcomes:
	python scripts/04_outcomes.py

features: ingest clean-data phenotype outcomes
	python src/qtx/features/build.py

eda:
	python scripts/05_eda.py

model:
	python scripts/06_train_models.py

dashboard:
	streamlit run dashboard/app.py

all: install ingest clean-data phenotype outcomes eda model

test:
	pytest tests/ -v

clean:
	rm -rf data/processed/ data/audit/ reports/ models/
