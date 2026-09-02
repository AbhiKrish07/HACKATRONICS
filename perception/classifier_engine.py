"""
Ensemble Classifier Engine for AV-01 Perception Stage.
Provides pure NumPy and Scikit-Learn compatible ensemble decision trees with predict_proba.
"""

import numpy as np
import pandas as pd

CLASSES = ["pedestrian", "vehicle", "cyclist", "static_obstacle", "unknown"]


class NumPyDecisionNode:
    def __init__(self, feature=None, threshold=None, left=None, right=None, probs=None):
        self.feature = feature
        self.threshold = threshold
        self.left = left
        self.right = right
        self.probs = probs  # dict of class -> prob if leaf


class NumPyDecisionTree:
    """Decision Tree Classifier with predict_proba support."""
    def __init__(self, max_depth: int = 10, min_samples_split: int = 4):
        self.max_depth = max_depth
        self.min_samples_split = min_samples_split
        self.root = None
        self.classes = CLASSES

    def fit(self, X: np.ndarray, y: np.ndarray, feature_names: list):
        self.feature_names = feature_names
        self.root = self._build_tree(X, y, depth=0)

    def _gini(self, y: np.ndarray) -> float:
        if len(y) == 0:
            return 0.0
        counts = np.bincount(y, minlength=len(self.classes))
        probs = counts / len(y)
        return 1.0 - float(np.sum(probs ** 2))

    def _build_tree(self, X: np.ndarray, y: np.ndarray, depth: int):
        n_samples, n_features = X.shape
        counts = np.bincount(y, minlength=len(self.classes))
        probs = {self.classes[i]: float(counts[i] / n_samples) for i in range(len(self.classes))}

        if depth >= self.max_depth or n_samples < self.min_samples_split or len(np.unique(y)) == 1:
            return NumPyDecisionNode(probs=probs)

        best_gain = -1.0
        best_feat, best_thresh = None, None
        current_gini = self._gini(y)

        # Random feature subset
        feats = np.random.choice(n_features, size=max(2, int(np.sqrt(n_features))), replace=False)
        for feat in feats:
            vals = np.percentile(X[:, feat], [15, 30, 50, 70, 85])
            for thresh in vals:
                left_mask = X[:, feat] <= thresh
                right_mask = ~left_mask
                if np.sum(left_mask) == 0 or np.sum(right_mask) == 0:
                    continue

                p_left = np.sum(left_mask) / n_samples
                p_right = 1.0 - p_left
                gain = current_gini - (p_left * self._gini(y[left_mask]) + p_right * self._gini(y[right_mask]))

                if gain > best_gain:
                    best_gain = gain
                    best_feat = feat
                    best_thresh = thresh

        if best_gain <= 1e-4 or best_feat is None:
            return NumPyDecisionNode(probs=probs)

        left_mask = X[:, best_feat] <= best_thresh
        left_child = self._build_tree(X[left_mask], y[left_mask], depth + 1)
        right_child = self._build_tree(X[~left_mask], y[~left_mask], depth + 1)

        return NumPyDecisionNode(
            feature=best_feat,
            threshold=best_thresh,
            left=left_child,
            right=right_child,
            probs=probs
        )

    def predict_proba_row(self, row: np.ndarray) -> np.ndarray:
        node = self.root
        while node.left is not None and node.right is not None:
            if row[node.feature] <= node.threshold:
                node = node.left
            else:
                node = node.right
        return np.array([node.probs.get(c, 0.0) for c in self.classes])


class NumPyRandomForestClassifier:
    """Ensemble Forest Classifier exposing standard scikit-learn inference contract."""
    def __init__(self, n_estimators: int = 50, max_depth: int = 12, random_state: int = 42):
        self.n_estimators = n_estimators
        self.max_depth = max_depth
        self.random_state = random_state
        self.trees = []
        self.classes_ = np.array(CLASSES)

    def fit(self, X_df: pd.DataFrame, y_series: pd.Series):
        np.random.seed(self.random_state)
        X = X_df.to_numpy(dtype=float)
        class_to_idx = {c: i for i, c in enumerate(CLASSES)}
        y = np.array([class_to_idx[val] for val in y_series], dtype=int)

        n_samples = len(X)
        self.trees = []
        for i in range(self.n_estimators):
            sample_indices = np.random.choice(n_samples, size=n_samples, replace=True)
            tree = NumPyDecisionTree(max_depth=self.max_depth)
            tree.fit(X[sample_indices], y[sample_indices], feature_names=list(X_df.columns))
            self.trees.append(tree)

    def predict_proba(self, X_df: pd.DataFrame) -> np.ndarray:
        X = X_df.to_numpy(dtype=float)
        all_tree_probs = []
        for tree in self.trees:
            tree_preds = np.array([tree.predict_proba_row(row) for row in X])
            all_tree_probs.append(tree_preds)

        avg_probs = np.mean(all_tree_probs, axis=0)
        row_sums = avg_probs.sum(axis=1, keepdims=True)
        row_sums[row_sums == 0] = 1.0
        return avg_probs / row_sums

    def predict(self, X_df: pd.DataFrame) -> np.ndarray:
        probs = self.predict_proba(X_df)
        indices = np.argmax(probs, axis=1)
        return self.classes_[indices]
