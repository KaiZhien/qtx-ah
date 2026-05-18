# QuantumTX — Active Health Analytics Pipeline

QuantumTX Active Health (QTX-AH) is a clinical data pipeline and interactive dashboard for analysing rehabilitation outcomes at an active-ageing physiotherapy centre. It ingests raw session data from an Excel workbook, cleans and phenotypes each patient record, computes MCID-based responder flags, and serves results through a Streamlit dashboard.

---

## Installation

```bash
# Clone and install in editable mode
pip install -e .
```

Or using Poetry:

```bash
poetry install
```

---

## Run the Full Pipeline

```bash
make all
```

This runs the following steps in order:

| Step | Command | Description |
|------|---------|-------------|
| 1 | `make ingest` | Load raw Excel → `data/raw/raw.parquet` |
| 2 | `make clean-data` | Normalise + plausibility checks → `data/processed/clean.parquet` |
| 3 | `make phenotype` | Assign cohort/group labels → `data/processed/phenotyped.parquet` |
| 4 | `make outcomes` | Compute change scores + responder flags → `data/processed/outcomes.parquet` |
| 5 | `make eda` | Generate EDA reports → `reports/` |
| 6 | `make model` | Train predictive models → `models/` |

---

## Run the Dashboard

```bash
make dashboard
```

Or directly:

```bash
streamlit run dashboard/app.py
```

The dashboard runs at `http://localhost:8501` and provides:
- Cohort overview and funnel charts
- Pre/post outcome distributions by group
- Responder rate heatmaps
- Individual patient lookup

---

## Run Tests

```bash
make test
# or
PYTHONPATH=src pytest tests/ -v
```

---

## How to Update Phenotype Rules

Phenotype group assignments are driven entirely by `config/phenotypes.yaml`. No code changes are required.

1. Open `config/phenotypes.yaml`
2. Add or edit regex patterns under the relevant `groups`, `regions`, or `flags` section
3. Optionally update the `priority` list (higher priority = assigned first when multiple groups match)
4. Optionally update `cohort_rollup` to map groups to dashboard cohort labels
5. Re-run the phenotype step:

```bash
make phenotype
```

Example — adding a new group:

```yaml
groups:
  my_new_group:
    label: "My New Group"
    patterns:
      - 'my pattern'
      - 'another pattern'
```

Then add it to `priority` and `cohort_rollup` as needed.

---

## How to Add a New Predictive Model

1. **Add the model config** to `config/models.yaml`:

```yaml
models:
  my_new_model:
    type: RandomForestClassifier
    target: overall_responder
    hyperparams:
      n_estimators: 200
      max_depth: 5
```

2. **Create the model module** at `src/qtx/models/newmodel.py`:

```python
from sklearn.ensemble import RandomForestClassifier

def build_model(cfg: dict):
    params = cfg.get("hyperparams", {})
    return RandomForestClassifier(**params)
```

3. **Register it** in `scripts/06_train_models.py` by importing your builder and adding it to the dispatch dict.

4. Re-run:

```bash
make model
```

---

## Data Dictionary

The authoritative column definitions, allowed values, and units are documented in the source workbook:

```
data/inputs/QTX_AH_2024_organised.xlsx  →  sheet: "Data Dictionary"
```

The pipeline's canonical column names (snake_case) and dtypes are defined in `config/schema.yaml`.
