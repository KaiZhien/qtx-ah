"""Streamlit dashboard — external / partner-facing summary view.

A minimal placeholder for the external partner view. Full analytics are
available only via the internal dashboard (app.py).

Run with: streamlit run dashboard/app_external.py
"""

import streamlit as st

st.set_page_config(page_title="QuantumTX AH — Partner View", layout="centered")

st.title("QuantumTX AH — Partner View")

st.info("Partner view coming soon.")

st.markdown(
    """
    This portal will provide aggregate programme outcome summaries suitable for
    external stakeholders and referring clinicians.

    Please contact the QuantumTX team for access to the full internal dashboard.
    """
)
