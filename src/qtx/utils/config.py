"""Load and merge YAML config files into a unified settings object.

Provides a get_config() function that reads config/settings.yaml plus any
referenced sub-configs (schema, cleaning, phenotypes, outcomes, missingness,
models) and returns a Pydantic BaseSettings-compatible object with dot-access.
Resolves all paths relative to the project root.
"""

pass
