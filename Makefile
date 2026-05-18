.PHONY: install ingest clean-data phenotype outcomes features eda model dashboard all test clean

PYTHON := $(shell [ -f .venv/bin/python3 ] && echo .venv/bin/python3 || echo python3)
export PYTHONPATH := src

install:
	$(PYTHON) -m pip install -e .

ingest:
	$(PYTHON) scripts/01_ingest.py

clean-data:
	$(PYTHON) scripts/02_clean.py

phenotype:
	$(PYTHON) scripts/03_phenotype.py

outcomes:
	$(PYTHON) scripts/04_outcomes.py

features: ingest clean-data phenotype outcomes
	$(PYTHON) scripts/07_export_dashboard_data.py

eda:
	$(PYTHON) scripts/05_eda.py

model:
	$(PYTHON) scripts/06_train_models.py

dashboard:
	PYTHONPATH=src streamlit run dashboard/app.py

all: ingest clean-data phenotype outcomes features eda model

test:
	PYTHONPATH=src $(PYTHON) -m pytest tests/ -v

clean:
	rm -rf data/processed/ data/audit/ reports/ models/
