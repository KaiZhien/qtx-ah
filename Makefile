.PHONY: install ingest clean-data phenotype outcomes features eda model dosage fall-risk dashboard dev api web all test clean reconcile-wearables

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

dosage:
	$(PYTHON) scripts/08_train_dosage_model.py

fall-risk:
	$(PYTHON) scripts/09_train_fall_risk_model.py

dashboard:
	PYTHONPATH=src streamlit run dashboard/app.py

api:
	source .venv/bin/activate && cd api && uvicorn main:app --reload --port 8000

web:
	cd web && npm run dev

dev:
	@trap 'kill 0' SIGINT; \
	(source .venv/bin/activate && cd api && uvicorn main:app --reload --port 8000) & \
	(cd web && npm run dev) & \
	wait

all: ingest clean-data phenotype outcomes features eda model dosage fall-risk

test:
	PYTHONPATH=src $(PYTHON) -m pytest tests/ -v

reconcile-wearables:
	PYTHONPATH=api $(PYTHON) scripts/10_reconcile_wearables.py

clean:
	rm -rf data/processed/ data/audit/ reports/ models/
