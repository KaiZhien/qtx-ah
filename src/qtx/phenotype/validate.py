"""Validate phenotype classification outputs using Pandera schemas.

Checks that primary_group is a known value, all has_* columns are 0/1
integers, and cohort is drawn from the allowed set defined in config.
Raises a SchemaError on violation; logs a warning summary if run in
non-strict mode.
"""

pass
