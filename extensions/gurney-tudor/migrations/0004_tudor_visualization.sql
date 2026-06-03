-- gurney-tudor 0004_tudor_visualization
-- Cache for the optional, on-demand HTML visualization a learner can request
-- per lesson. Stays NULL until the user clicks "Visualize" in the panel; once
-- populated, the panel renders it from cache so a repeat view is instant and
-- costs no further model time. Cleared when the lesson is regenerated, so a
-- rebuilt lesson never shows a stale visual.

ALTER TABLE tudor_lessons ADD COLUMN visualization_html TEXT;
