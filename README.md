# 📊 Kolmogorov-Smirnov Test

Statistical analysis tool implementing the K-S test for comparing probability distributions.

## 🎯 Features

- ✅ One-sample K-S test
- ✅ Two-sample K-S test
- ✅ P-value calculation
- ✅ Distribution fitting
- ✅ Visualization tools
- ✅ Batch processing

## 📋 Requirements

- Python 3.8+
- NumPy, SciPy, Matplotlib, Pandas

## 🔧 Installation

 + "`" + @"
bash
git clone https://github.com/CostaJr007/Kolmogorov.git
cd Kolmogorov
pip install -r requirements.txt
 + "`" + @"

## 💡 Usage

### Basic Usage

 + "`" + @"
python
from ks_test import KolmogorovSmirnov

# One-sample test
ks = KolmogorovSmirnov()
statistic, p_value = ks.one_sample(data, 'norm')

# Two-sample test
stat, p = ks.two_sample(data1, data2)
 + "`" + @"

## 📊 Statistical Tests

| Test | Purpose | Use Case |
|------|---------|----------|
| One-sample | Compare to reference | Normality test |
| Two-sample | Compare two datasets | A/B testing |

## 🎯 Applications

- Quality control
- A/B testing
- Model validation
- Distribution fitting
- Anomaly detection

## 📄 License

MIT License

## 👤 Author

**CostaJr007**

## 📚 References

- [Kolmogorov-Smirnov Test](https://en.wikipedia.org/wiki/Kolmogorov%E2%80%93Smirnov_test)

---
⭐ Statistical analysis made simple!