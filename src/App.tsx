import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as XLSX from 'xlsx';
import PptxGenJS from 'pptxgenjs';
import html2canvas from 'html2canvas';
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, ReferenceDot, Label, ReferenceArea
} from 'recharts';
import { 
  Upload, FileText, Download, Settings, RefreshCw,
  Target, TrendingUp, Users, DollarSign, Fingerprint, Activity,
  ChevronRight, BarChart2, Table as TableIcon, CheckCircle, Maximize2
} from 'lucide-react';

// --- Type Definitions ---
interface DataRow { [key: string]: any; }
interface ProcessedRow {
  price: number;
  buy: number;
  w: number;
  [key: string]: any;
}
interface AggregatedRow {
  price: number;
  n_rows: number;
  demand: number;
  revenue: number;
  demand_lo?: number;
  demand_hi?: number;
  revenue_lo?: number;
  revenue_hi?: number;
}
interface InterpolatedRow extends AggregatedRow {
  rev_scaled?: number; 
  demand_ci?: [number, number]; // For Recharts Range
  revenue_ci?: [number, number]; // For Recharts Range
}

// --- Helper Functions ---

const mapBuy = (val: any): number => {
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (typeof val === 'number') return val > 0 ? 1 : 0;
  if (typeof val === 'string') {
    const v = val.trim().toLowerCase();
    if (['1', 'yes', 'y', 'true', 'on'].includes(v)) return 1;
    return 0;
  }
  return 0;
};

// Linear Interpolation
const interpolate = (x: number, x0: number, x1: number, y0: number, y1: number) => {
  if (x1 === x0) return y0;
  return y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
};

const formatNumber = (num: number, decimals = 2) => {
  if (isNaN(num) || num === null) return "-";
  return new Intl.NumberFormat('en-US', { 
    minimumFractionDigits: decimals, maximumFractionDigits: decimals 
  }).format(num);
};

// --- Main Component ---

const App = () => {
  // --- State: Configuration ---
  const [file, setFile] = useState<File | null>(null);
  const [rawData, setRawData] = useState<DataRow[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  
  const [dataFormat, setDataFormat] = useState<'long' | 'wide'>('long');
  const [idCol, setIdCol] = useState('');
  const [segCols, setSegCols] = useState<string[]>([]);
  const [priceCol, setPriceCol] = useState('');
  const [buyCol, setBuyCol] = useState('');
  const [widePriceCols, setWidePriceCols] = useState<string[]>([]);
  const [priceRegex, setPriceRegex] = useState('\\d+');
  const [wideProcessed, setWideProcessed] = useState(false);

  const [currency, setCurrency] = useState('$');
  const [customCurrency, setCustomCurrency] = useState('');
  const [revScale, setRevScale] = useState(100);
  
  const [useWeights, setUseWeights] = useState(false);
  const [weightCol, setWeightCol] = useState('');
  
  const [showRange, setShowRange] = useState(false);
  const [rangeMethod, setRangeMethod] = useState<'pct' | 'original'>('pct');
  const [rangePctRev, setRangePctRev] = useState(95);
  
  const [useBoot, setUseBoot] = useState(false);
  const [bootB, setBootB] = useState(300);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  
  // Ref for Chart Capture
  const chartRef = useRef<HTMLDivElement>(null);

  // --- State: Filtering ---
  const [activeFilters, setActiveFilters] = useState<{[key: string]: string[]}>({});

  // --- 1. File Handling ---
  const handleFileUpload = (f: File) => {
    if (f) {
      setFile(f);
      const reader = new FileReader();
      reader.onload = (evt) => {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws) as DataRow[];
        setRawData(data);
        if (data.length > 0) {
          const cols = Object.keys(data[0]);
          setColumns(cols);
          // Auto-guess ID
          const likelyId = cols.find(c => /id|resp/i.test(c));
          if (likelyId) setIdCol(likelyId);
        }
      };
      reader.readAsBinaryString(f);
    }
  };

  const effectiveCurrency = currency === 'Other' ? customCurrency : currency;

  // --- 2. Data Processing ---
  const processedData = useMemo<ProcessedRow[]>(() => {
    if (rawData.length === 0 || !idCol) return [];

    let data: ProcessedRow[] = [];

    if (dataFormat === 'long') {
      if (!priceCol || !buyCol) return [];
      data = rawData.map(row => ({
        ...row,
        price: Number(row[priceCol]),
        buy: mapBuy(row[buyCol]),
        w: useWeights && weightCol ? Number(row[weightCol]) || 1 : 1
      })).filter(r => !isNaN(r.price));
    } else {
      // Wide Format
      if (!wideProcessed || widePriceCols.length === 0) return [];
      const regex = new RegExp(priceRegex);
      
      rawData.forEach(row => {
        const baseW = useWeights && weightCol ? Number(row[weightCol]) || 1 : 1;
        widePriceCols.forEach(col => {
          const match = col.match(regex);
          if (match) {
            const p = Number(match[0]);
            if (!isNaN(p)) {
              data.push({
                ...row,
                price: p,
                buy: mapBuy(row[col]),
                w: baseW
              });
            }
          }
        });
      });
    }
    return data;
  }, [rawData, dataFormat, idCol, priceCol, buyCol, widePriceCols, priceRegex, wideProcessed, useWeights, weightCol]);

  // --- 3. Filter Logic ---
  const filteredData = useMemo(() => {
    return processedData.filter(row => {
      for (const seg of segCols) {
        if (activeFilters[seg] && activeFilters[seg].length > 0) {
          if (!activeFilters[seg].includes(String(row[seg]))) return false;
        }
      }
      return true;
    });
  }, [processedData, activeFilters, segCols]);

  // --- 4. Statistics & Bootstrap ---
  const [stats, setStats] = useState<{
    res: AggregatedRow[], 
    interp: InterpolatedRow[], 
    opt: InterpolatedRow, 
    range: {lo: number | null, hi: number | null},
    baseSize: number
  } | null>(null);

  useEffect(() => {
    if (filteredData.length === 0) {
      setStats(null);
      return;
    }

    const runAnalysis = async () => {
      const uniqueIds = new Set(filteredData.map(d => d[idCol]));
      const baseSize = uniqueIds.size;

      const priceMap = new Map<number, {sumWBuy: number, sumW: number, count: number}>();
      filteredData.forEach(d => {
        if (!priceMap.has(d.price)) priceMap.set(d.price, { sumWBuy: 0, sumW: 0, count: 0 });
        const entry = priceMap.get(d.price)!;
        entry.sumWBuy += d.buy * d.w;
        entry.sumW += d.w;
        entry.count += 1;
      });

      const res: AggregatedRow[] = Array.from(priceMap.entries()).map(([price, val]) => {
        const demand = val.sumW > 0 ? val.sumWBuy / val.sumW : 0;
        return {
          price,
          n_rows: val.count,
          demand,
          revenue: price * demand * revScale,
          demand_lo: undefined, demand_hi: undefined,
          revenue_lo: undefined, revenue_hi: undefined
        };
      }).sort((a, b) => a.price - b.price);

      if (useBoot) {
        setIsBootstrapping(true);
        await new Promise(r => setTimeout(r, 10));
        
        const uniqueIdArr = Array.from(uniqueIds);
        const n = uniqueIdArr.length;
        const prices = res.map(r => r.price);
        const bootDemands: number[][] = prices.map(() => []);

        const dataById = new Map<any, any[]>();
        filteredData.forEach(d => {
           const id = d[idCol];
           if(!dataById.has(id)) dataById.set(id, []);
           dataById.get(id)!.push(d);
        });

        for (let b = 0; b < bootB; b++) {
          const sampleIds = Array.from({length: n}, () => uniqueIdArr[Math.floor(Math.random() * n)]);
          const bPriceMap = new Map<number, {sumWBuy: number, sumW: number}>();
          prices.forEach(p => bPriceMap.set(p, {sumWBuy: 0, sumW: 0}));

          sampleIds.forEach(id => {
            const rows = dataById.get(id);
            if(rows) {
              rows.forEach(r => {
                const entry = bPriceMap.get(r.price);
                if(entry) {
                  entry.sumWBuy += r.buy * r.w;
                  entry.sumW += r.w;
                }
              });
            }
          });

          prices.forEach((p, idx) => {
            const entry = bPriceMap.get(p)!;
            const d = entry.sumW > 0 ? entry.sumWBuy / entry.sumW : 0;
            bootDemands[idx].push(d);
          });
        }

        res.forEach((r, idx) => {
          const sorted = bootDemands[idx].sort((a, b) => a - b);
          r.demand_lo = sorted[Math.floor(0.05 * sorted.length)];
          r.demand_hi = sorted[Math.floor(0.95 * sorted.length)];
          r.revenue_lo = r.price * (r.demand_lo || 0) * revScale;
          r.revenue_hi = r.price * (r.demand_hi || 0) * revScale;
        });
        setIsBootstrapping(false);
      }

      // Interpolation
      const pMin = res[0].price;
      const pMax = res[res.length - 1].price;
      const steps = 100;
      const stepSize = (pMax - pMin) / steps;
      
      const interp: InterpolatedRow[] = [];
      for (let i = 0; i <= steps; i++) {
        const x = pMin + i * stepSize;
        let idx = res.findIndex(r => r.price >= x);
        if (idx === -1) idx = res.length - 1;
        const p1 = res[idx];
        const p0 = idx > 0 ? res[idx - 1] : p1;
        
        const d = interpolate(x, p0.price, p1.price, p0.demand, p1.demand);
        const rLo = (p0.revenue_lo !== undefined && p1.revenue_lo !== undefined) 
           ? interpolate(x, p0.price, p1.price, p0.revenue_lo, p1.revenue_lo) : undefined;
        const dLo = (p0.demand_lo !== undefined && p1.demand_lo !== undefined) 
           ? interpolate(x, p0.price, p1.price, p0.demand_lo, p1.demand_lo) : undefined;
        const dHi = (p0.demand_hi !== undefined && p1.demand_hi !== undefined) 
           ? interpolate(x, p0.price, p1.price, p0.demand_hi, p1.demand_hi) : undefined;
        
        interp.push({
          price: x,
          n_rows: 0,
          demand: d,
          revenue: x * d * revScale,
          revenue_lo: rLo,
          demand_lo: dLo,
          demand_hi: dHi,
          // Prepare Range Arrays for Recharts Area
          demand_ci: (dLo !== undefined && dHi !== undefined) ? [dLo, dHi] : undefined,
          revenue_ci: (rLo !== undefined && rLo !== undefined) ? [rLo, rLo] : undefined
        });
      }

      let opt = interp[0];
      interp.forEach(r => { if(r.revenue > opt.revenue) opt = r; });
      const maxRev = opt.revenue || 1;
      
      interp.forEach(r => r.rev_scaled = r.revenue / maxRev);
      res.forEach(r => (r as InterpolatedRow).rev_scaled = r.revenue / maxRev);

      const range = { lo: null as number | null, hi: null as number | null };
      if (showRange) {
        let threshold = 0;
        if (rangeMethod === 'pct') {
          threshold = maxRev * (rangePctRev / 100);
        } else {
          // Statistical: Use bootstrapped Lower CI of OPP or 95% fallback
          if (opt.revenue_lo !== undefined) {
            threshold = opt.revenue_lo;
          } else {
            threshold = maxRev * 0.95;
          }
        }
        
        const pricesAbove = interp.filter(r => r.revenue >= threshold).map(r => r.price);
        if (pricesAbove.length > 0) {
          range.lo = Math.min(...pricesAbove);
          range.hi = Math.max(...pricesAbove);
        }
      }

      setStats({ res, interp, opt, range, baseSize });
    };

    runAnalysis();
  }, [filteredData, useBoot, bootB, revScale, showRange, rangeMethod, rangePctRev, idCol]);


  // --- 5. Export Logic ---
  const handlePPTX = async () => {
    if (!stats) return;
    const pres = new PptxGenJS();

    // 1. Template Check
    let useTemplate = false;
    try {
      const tplCheck = await fetch('Toluna_GG_Template.pptx', { method: 'HEAD' });
      if (tplCheck.ok) {
        console.log("Template file found. Using layout definitions if available.");
        useTemplate = true;
      }
    } catch(e) { /* ignore */ }
    
    // --- TEMPLATE CONFIGURATION (Master Slide Fallback) ---
    pres.defineSlideMaster({
      title: 'MASTER_SLIDE',
      background: { color: 'F3F4F6' },
      objects: [
        { rect: { x: 0, y: 0, w: '100%', h: 0.8, fill: { color: 'FFFFFF' } } },
        { line: { x: 0, y: 0.8, w: '100%', h: 0, line: { color: 'E2E8F0', width: 1 } } },
        { text: { text: "Gabor-Granger Pro", options: { x: 0.5, y: 0.2, fontSize: 18, bold: true, color: '2563EB', fontFace: "Calibri" } } },
        { text: { text: "CONFIDENTIAL | Generated by Gabor-Granger Analyzer", options: { x: 0.5, y: 5.25, w: 9, align: 'center', fontSize: 9, color: '94A3B8', fontFace: "Calibri" } } }
      ]
    });
    
    const masterName = 'MASTER_SLIDE';

    // Slide 1: Cover
    let slide = pres.addSlide({ masterName });
    slide.addText("Pricing Optimization Study", { x: 0.5, y: 2.0, w: "90%", fontSize: 32, bold: true, align: "center", fontFace: "Calibri", color: '1E293B' });
    slide.addText(`Gabor-Granger Analytical Insights\nEffective Sample: ${stats.baseSize}\nGenerated: ${new Date().toLocaleDateString()}`, 
      { x: 0.5, y: 3.2, w: "90%", fontSize: 18, align: "center", color: "64748B", fontFace: "Calibri" });

    // Slide 2: Parameters
    slide = pres.addSlide({ masterName });
    slide.addText("Research Parameters & Methodology", { x: 0.5, y: 0.25, fontSize: 20, bold: true, fontFace: "Calibri", color: '1E293B' });
    
    const filterTxt = Object.entries(activeFilters).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') || "None";
    const rangeTxt = showRange 
      ? (rangeMethod === 'pct' ? `Revenue Retention: > ${rangePctRev}% of Max` : "Statistical Confidence Lower Bound")
      : "Analysis focused on peak OPP only.";

    const methodologyText = [
      { text: "ANALYTICAL FRAMEWORK", options: { bold: true, fontSize: 11, breakLine: true, color: '334155' } },
      { text: "• Methodology: Gabor-Granger Pricing Model.", options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: "• Curve Fitting: Continuous Linear Interpolation.", options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: "• Objective: Revenue-volume optimization via Optimal Price Point (OPP) analysis.", options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: " ", options: { fontSize: 11, breakLine: true } },
      { text: "SAMPLE CONTEXT", options: { bold: true, fontSize: 11, breakLine: true, color: '334155' } },
      { text: `• Base Size (N): ${stats.baseSize} unique validated respondents.`, options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: `• Segmentation: ${filterTxt}`, options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: `• Scaling: Revenue results extrapolated across ${revScale} market units.`, options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: `• Range Calculation: ${rangeTxt}`, options: { fontSize: 11, breakLine: true, color: '334155' } }
    ];
    slide.addText(methodologyText, { x: 0.5, y: 1.2, w: 9, h: 4, align: "left", fontFace: "Calibri" });

    // Slide 3: Visualization (IMAGE CAPTURE)
    slide = pres.addSlide({ masterName });
    slide.addText("Pricing Optimization Strategy Map", { x: 0.5, y: 0.25, fontSize: 20, bold: true, fontFace: "Calibri", color: '1E293B' });
    
    if (chartRef.current) {
        try {
            // Temporarily ensure chart background is white for capture
            const originalBg = chartRef.current.style.backgroundColor;
            chartRef.current.style.backgroundColor = '#FFFFFF';
            
            const canvas = await html2canvas(chartRef.current, {
                scale: 2, // High resolution
                useCORS: true,
                backgroundColor: '#FFFFFF'
            });
            
            chartRef.current.style.backgroundColor = originalBg; // Restore
            const imgData = canvas.toDataURL('image/png');
            
            slide.addImage({ 
                data: imgData, 
                x: 0.5, y: 1.0, w: 9, h: 4.5 
            });
        } catch (err) {
            console.error("Chart capture failed", err);
            slide.addText("Chart generation failed. See data table.", { x: 1, y: 2, color: 'FF0000' });
        }
    } else {
        slide.addText("Chart not rendered in view.", { x: 1, y: 2 });
    }

    // Slide 4: Dashboard
    slide = pres.addSlide({ masterName });
    slide.addText("Strategic Executive Summary", { x: 0.5, y: 0.25, fontSize: 20, bold: true, fontFace: "Calibri", color: '1E293B' });
    
    slide.addText("Optimal Price Point (OPP)", { x: 0.5, y: 1.0, w: 4.2, h: 0.4, fontSize: 11, color: "666666", fontFace: "Calibri" });
    slide.addText(`${effectiveCurrency}${formatNumber(stats.opt.price)}`, { x: 0.5, y: 1.4, w: 4.2, h: 0.8, fontSize: 28, bold: true, color: "2563eb", fontFace: "Calibri" });
    
    slide.addText("Statistically Valid Range", { x: 5.3, y: 1.0, w: 4.2, h: 0.4, fontSize: 11, color: "666666", fontFace: "Calibri" });
    const rangeStr = stats.range.lo !== null 
      ? `${effectiveCurrency}${formatNumber(stats.range.lo)} - ${effectiveCurrency}${formatNumber(stats.range.hi!)}`
      : "N/A";
    slide.addText(rangeStr, { x: 5.3, y: 1.4, w: 4.2, h: 0.8, fontSize: 28, bold: true, color: "059669", fontFace: "Calibri" });

    const insightTxt = [
      { text: "PERFORMANCE ESTIMATES AT OPTIMUM", options: { bold: true, fontSize: 11, breakLine: true, color: '334155' } },
      { text: `• Projected Market Share / Demand: ${formatNumber(stats.opt.demand * 100, 1)}%`, options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: `• Estimated Revenue Potential: ${effectiveCurrency}${formatNumber(stats.opt.revenue, 2)}`, options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: " ", options: { fontSize: 11, breakLine: true } },
      { text: "STRATEGIC IMPLICATIONS", options: { bold: true, fontSize: 11, breakLine: true, color: '334155' } },
      { text: `• Pricing Core: Data identifies ${effectiveCurrency}${formatNumber(stats.opt.price)} as the peak revenue efficiency point.`, options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: `• Market Tolerance: ${showRange ? `Stability observed within ${rangeStr}.` : "Range analysis not requested."}`, options: { fontSize: 11, breakLine: true, color: '334155' } },
      { text: "• Guidance: Align commercial strategy with the OPP to maximize top-line yield.", options: { fontSize: 11, breakLine: true, color: '334155' } }
    ];
    slide.addText(insightTxt, { x: 0.5, y: 2.2, w: 9, h: 3.06, fill: { color: "F7F9FA" }, fontFace: "Calibri" });

    // Slide 5: Data Table
    slide = pres.addSlide({ masterName });
    slide.addText("Quantitative Metric Analysis", { x: 0.5, y: 0.25, fontSize: 20, bold: true, fontFace: "Calibri", color: '1E293B' });
    
    const tableHeaders = [
      "Price", "N", "Demand", "Demand Lo", "Demand Hi", "Revenue", "Rev Lo", "Rev Hi"
    ].map(h => ({ 
      text: h, 
      options: { fill: { color: "2563eb" }, color: "ffffff", bold: true } 
    }));
    
    const tableRows = stats.res.map(r => [
      r.price.toFixed(2),
      r.n_rows,
      formatNumber(r.demand * 100) + "%",
      r.demand_lo !== undefined ? formatNumber(r.demand_lo * 100) + "%" : "-",
      r.demand_hi !== undefined ? formatNumber(r.demand_hi * 100) + "%" : "-",
      `${effectiveCurrency}${formatNumber(r.revenue)}`,
      r.revenue_lo !== undefined ? `${effectiveCurrency}${formatNumber(r.revenue_lo)}` : "-",
      r.revenue_hi !== undefined ? `${effectiveCurrency}${formatNumber(r.revenue_hi)}` : "-"
    ].map(c => ({ text: String(c) })));

    slide.addTable([tableHeaders, ...tableRows], {
      x: 0.5, y: 1.0,
      colW: [1.1, 0.6, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1],
      rowH: 0.5,
      fontSize: 10,
      fontFace: "Calibri",
      border: { pt: 1, color: "e2e8f0" },
      fill: { color: "ffffff" }
    });

    pres.writeFile({ fileName: `Gabor-Granger-Report-${new Date().toISOString().split('T')[0]}.pptx` });
  };

  const handleDownloadCSV = () => {
    if(!stats) return;
    const ws = XLSX.utils.json_to_sheet(stats.res.map(r => ({
      Price: r.price,
      N: r.n_rows,
      Demand: r.demand,
      Revenue: r.revenue,
      Demand_Lo: r.demand_lo,
      Demand_Hi: r.demand_hi,
      Revenue_Lo: r.revenue_lo,
      Revenue_Hi: r.revenue_hi
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Results");
    XLSX.writeFile(wb, `GG-Analysis-${new Date().toISOString().split('T')[0]}.csv`);
  };

  return (
    <div className="container-fluid p-4" style={{ maxWidth: '1600px' }}>
      <div className="d-flex justify-content-between align-items-center mb-4">
        <div>
          <h3 className="fw-bold text-dark mb-0 d-flex align-items-center gap-2">
            <Activity className="text-primary" /> Gabor-Granger Analyzer <span className="badge bg-primary fs-6 rounded-pill">Pro</span>
          </h3>
          <p className="text-muted mb-0 small mt-1">Pricing sensitivity & revenue optimization engine</p>
        </div>
        <div className="d-flex gap-2">
          {stats && (
            <>
              <button className="btn btn-outline-primary d-flex align-items-center gap-2" onClick={handleDownloadCSV}>
                <Download size={18} /> CSV
              </button>
              <button className="btn btn-success d-flex align-items-center gap-2 shadow-sm" onClick={handlePPTX}>
                <FileText size={18} /> Export PPTX
              </button>
            </>
          )}
        </div>
      </div>

      <div className="row g-4">
        <div className="col-lg-3">
          <div className="card mb-3">
            <div className="card-header d-flex align-items-center gap-2">
              <Upload size={18} className="text-primary"/> Data Source
            </div>
            <div className="card-body">
              <div 
                className="dropzone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    handleFileUpload(e.dataTransfer.files[0]);
                  }
                }}
                onClick={() => document.getElementById('fileInput')?.click()}
              >
                <Upload size={32} className="text-secondary mb-2" />
                <div className="small fw-bold text-dark">
                  {file ? file.name : "Drop file or click to upload"}
                </div>
                <div className="small text-muted mt-1">.csv, .xls, .xlsx</div>
                <input 
                  id="fileInput" 
                  type="file" 
                  hidden 
                  accept=".csv,.xls,.xlsx" 
                  onChange={(e) => e.target.files && handleFileUpload(e.target.files[0])} 
                />
              </div>
            </div>
          </div>

          {columns.length > 0 && (
            <div className="card mb-3">
               <div className="card-header d-flex align-items-center gap-2">
                 <Settings size={18} className="text-primary"/> Column Mapping
               </div>
               <div className="card-body">
                  <div className="mb-3">
                    <label className="form-label">Data Format</label>
                    <div className="btn-group w-100" role="group">
                      <button className={`btn btn-sm ${dataFormat === 'long' ? 'btn-primary' : 'btn-outline-primary'}`} onClick={() => setDataFormat('long')}>Long</button>
                      <button className={`btn btn-sm ${dataFormat === 'wide' ? 'btn-primary' : 'btn-outline-primary'}`} onClick={() => setDataFormat('wide')}>Wide</button>
                    </div>
                  </div>

                  <div className="mb-3">
                    <label className="form-label">Respondent ID</label>
                    <select className="form-select form-select-sm" value={idCol} onChange={e => setIdCol(e.target.value)}>
                      <option value="">Select ID...</option>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>

                  {dataFormat === 'long' ? (
                    <>
                      <div className="mb-3">
                        <label className="form-label">Price Column</label>
                        <select className="form-select form-select-sm" value={priceCol} onChange={e => setPriceCol(e.target.value)}>
                          <option value="">Select Price...</option>
                          {columns.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      <div className="mb-3">
                        <label className="form-label">Buy Indicator</label>
                        <select className="form-select form-select-sm" value={buyCol} onChange={e => setBuyCol(e.target.value)}>
                          <option value="">Select Buy...</option>
                          {columns.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    </>
                  ) : (
                    <>
                       <div className="mb-3">
                        <label className="form-label">Price Columns (Wide)</label>
                        <select multiple className="form-select form-select-sm" size={4}
                           value={widePriceCols}
                           onChange={e => setWidePriceCols(Array.from(e.target.selectedOptions, o => o.value))}>
                           {columns.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                       </div>
                       <div className="mb-3">
                         <label className="form-label">Extract Regex</label>
                         <div className="input-group input-group-sm">
                           <input type="text" className="form-control" value={priceRegex} onChange={e => setPriceRegex(e.target.value)} />
                           <button className="btn btn-outline-secondary" onClick={() => setWideProcessed(true)}>Apply</button>
                         </div>
                       </div>
                    </>
                  )}

                  <hr className="my-3 opacity-50"/>
                  <div className="mb-2">
                    <label className="form-label">Segment Filters</label>
                    <select multiple className="form-select form-select-sm" size={3} value={segCols} onChange={e => setSegCols(Array.from(e.target.selectedOptions, o => o.value))}>
                      {columns.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
               </div>
            </div>
          )}

          <div className="card mb-3">
             <div className="card-header d-flex align-items-center gap-2">
                <Target size={18} className="text-primary"/> Parameters
             </div>
             <div className="card-body">
                <div className="row g-2 mb-3">
                   <div className="col-6">
                      <label className="form-label">Currency</label>
                      <select className="form-select form-select-sm" value={currency} onChange={e => setCurrency(e.target.value)}>
                        <option>$</option><option>€</option><option>£</option><option>Other</option>
                      </select>
                   </div>
                   {currency === 'Other' && (
                     <div className="col-6">
                       <label className="form-label">Symbol</label>
                       <input type="text" className="form-control form-control-sm" value={customCurrency} onChange={e => setCustomCurrency(e.target.value)} />
                     </div>
                   )}
                   <div className="col-12">
                     <label className="form-label">Revenue Scaling (Factor)</label>
                     <input type="number" className="form-control form-control-sm" value={revScale} onChange={e => setRevScale(Number(e.target.value))} />
                   </div>
                </div>

                <div className="form-check form-switch mb-3">
                  <input className="form-check-input" type="checkbox" id="wCheck" checked={useWeights} onChange={e => setUseWeights(e.target.checked)} />
                  <label className="form-check-label small" htmlFor="wCheck">Enable Weights</label>
                </div>
                {useWeights && (
                  <div className="mb-3">
                     <select className="form-select form-select-sm" value={weightCol} onChange={e => setWeightCol(e.target.value)}>
                        <option value="">Weight Column...</option>
                        {columns.map(c => <option key={c} value={c}>{c}</option>)}
                     </select>
                  </div>
                )}
                
                <hr className="my-3 opacity-50"/>
                
                <div className="form-check form-switch mb-2">
                  <input className="form-check-input" type="checkbox" id="rangeCheck" checked={showRange} onChange={e => setShowRange(e.target.checked)} />
                  <label className="form-check-label small" htmlFor="rangeCheck">Show Optimal Range</label>
                </div>
                
                {showRange && (
                   <div className="bg-light p-3 rounded mb-3">
                      <div className="form-check mb-2">
                        <input className="form-check-input" type="radio" name="rm" id="rm1" checked={rangeMethod === 'pct'} onChange={() => setRangeMethod('pct')} />
                        <label className="form-check-label small" htmlFor="rm1">% Max Revenue</label>
                      </div>
                      {rangeMethod === 'pct' && (
                        <input type="number" className="form-control form-control-sm mb-2" value={rangePctRev} onChange={e => setRangePctRev(Number(e.target.value))} />
                      )}
                      <div className="form-check">
                        <input className="form-check-input" type="radio" name="rm" id="rm2" checked={rangeMethod === 'original'} onChange={() => setRangeMethod('original')} />
                        <label className="form-check-label small" htmlFor="rm2">Statistical (CI)</label>
                      </div>
                   </div>
                )}
                
                <div className="form-check form-switch">
                  <input className="form-check-input" type="checkbox" id="bootCheck" checked={useBoot} onChange={e => setUseBoot(e.target.checked)} />
                  <label className="form-check-label small" htmlFor="bootCheck">Bootstrap Confidence</label>
                </div>
             </div>
          </div>
        </div>

        <div className="col-lg-9">
           {segCols.length > 0 && (
              <div className="card mb-4">
                <div className="card-body py-3 d-flex align-items-center gap-3">
                  <Fingerprint className="text-muted" size={20} />
                  <div className="d-flex gap-3 flex-wrap flex-grow-1">
                    {segCols.map(seg => {
                       const uniqueVals = Array.from(new Set(processedData.map(r => r[seg]))).sort();
                       return (
                         <div key={seg} style={{ minWidth: '150px' }}>
                            <label className="small text-muted d-block mb-1">{seg}</label>
                            <select multiple className="form-select form-select-sm" 
                              value={activeFilters[seg] || []}
                              onChange={e => {
                                const opts = Array.from(e.target.selectedOptions, o => o.value);
                                setActiveFilters(prev => ({...prev, [seg]: opts}));
                              }}>
                              {uniqueVals.map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                         </div>
                       )
                    })}
                  </div>
                </div>
              </div>
           )}

           {stats ? (
             <>
               <div className="row g-3 mb-4 row-cols-1 row-cols-md-5">
                  <div className="col">
                    <div className="card metric-card text-white h-100" style={{ backgroundColor: '#007bff' }}>
                      <Target className="icon-bg" size={60} />
                      <div className="small opacity-75 fw-bold text-uppercase tracking-wider">OPP Price</div>
                      <div className="h3 fw-bold mt-2 mb-0">{effectiveCurrency}{formatNumber(stats.opt.price)}</div>
                    </div>
                  </div>
                  <div className="col">
                    <div className="card metric-card text-white h-100" style={{ backgroundColor: '#6c757d' }}>
                      <TrendingUp className="icon-bg" size={60} />
                      <div className="small opacity-75 fw-bold text-uppercase tracking-wider">Range</div>
                      <div className="h5 fw-bold mt-2 mb-0">
                        {showRange && stats.range.lo !== null 
                          ? `${effectiveCurrency}${formatNumber(stats.range.lo)} - ${effectiveCurrency}${formatNumber(stats.range.hi!)}`
                          : "Disabled"}
                      </div>
                    </div>
                  </div>
                  <div className="col">
                    <div className="card metric-card text-white h-100" style={{ backgroundColor: '#0dcaf0' }}>
                      <Users className="icon-bg" size={60} />
                      <div className="small opacity-75 fw-bold text-uppercase tracking-wider">Demand</div>
                      <div className="h3 fw-bold mt-2 mb-0">{formatNumber(stats.opt.demand * 100, 1)}%</div>
                    </div>
                  </div>
                  <div className="col">
                    <div className="card metric-card text-white h-100" style={{ backgroundColor: '#198754' }}>
                      <DollarSign className="icon-bg" size={60} />
                      <div className="small opacity-75 fw-bold text-uppercase tracking-wider">Max Rev</div>
                      <div className="h4 fw-bold mt-2 mb-0">{effectiveCurrency}{formatNumber(stats.opt.revenue, 0)}</div>
                    </div>
                  </div>
                  <div className="col">
                    <div className="card metric-card text-white h-100" style={{ backgroundColor: '#212529' }}>
                      <Fingerprint className="icon-bg" size={60} />
                      <div className="small opacity-75 fw-bold text-uppercase tracking-wider">Sample</div>
                      <div className="h3 fw-bold mt-2 mb-0">{stats.baseSize}</div>
                    </div>
                  </div>
               </div>

               <div className="card mb-4">
                 <div className="card-header d-flex justify-content-between align-items-center">
                   <div className="d-flex align-items-center gap-2">
                     <BarChart2 size={18} className="text-primary"/> Analysis Visualization
                   </div>
                 </div>
                 <div className="card-body">
                    <div style={{ height: 500, width: '100%' }} ref={chartRef}>
                      <ResponsiveContainer>
                        <ComposedChart data={stats.interp} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
                          <defs>
                            <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                              <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                            </linearGradient>
                            <linearGradient id="colorDem" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1}/>
                              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                          <XAxis dataKey="price" type="number" domain={['dataMin', 'dataMax']} 
                             tickFormatter={v => `${effectiveCurrency}${v}`} 
                             label={{ value: `Price (${effectiveCurrency})`, position: 'bottom', offset: 0 }} 
                             tick={{fill: '#6b7280'}}
                          />
                          <YAxis yAxisId="left" orientation="left" tickFormatter={v => `${(v * 100).toFixed(0)}%`} label={{ value: 'Demand', angle: -90, position: 'insideLeft' }} tick={{fill: '#3b82f6'}} />
                          <YAxis yAxisId="right" orientation="right" tickFormatter={v => `${effectiveCurrency}${formatNumber(v * (stats.opt.revenue || 1), 0)}`} label={{ value: 'Revenue', angle: 90, position: 'insideRight' }} tick={{fill: '#10b981'}} />
                          
                          <Tooltip 
                            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                            formatter={(val: any, name: string) => {
                              if (Array.isArray(val)) return null; 
                              if (name.includes('Revenue')) return `${effectiveCurrency}${formatNumber(val * (stats.opt.revenue || 1))}`;
                              return `${(val * 100).toFixed(1)}%`;
                            }}
                            labelFormatter={v => `Price: ${effectiveCurrency}${formatNumber(v)}`}
                          />
                          <Legend verticalAlign="top" iconType="circle"/>
                          
                          {showRange && stats.range.lo !== null && stats.range.hi !== null && (
                            <ReferenceArea 
                                yAxisId="right" 
                                x1={stats.range.lo} 
                                x2={stats.range.hi} 
                                fill="#22c55e" 
                                fillOpacity={0.1} 
                            />
                          )}

                          {useBoot && (
                            <Area 
                              yAxisId="left" 
                              type="monotone" 
                              dataKey="demand_ci" 
                              stroke="none" 
                              fill="#93c5fd" 
                              fillOpacity={0.3} 
                              name="Demand 95% CI"
                            />
                          )}
                          
                          <Area 
                            yAxisId="left" 
                            type="monotone" 
                            dataKey="demand" 
                            stroke="#3b82f6" 
                            strokeWidth={3} 
                            fill="url(#colorDem)" 
                            name="Demand Curve"
                          />

                          <Area 
                            yAxisId="right" 
                            type="monotone" 
                            dataKey="rev_scaled" 
                            stroke="#10b981" 
                            strokeWidth={3} 
                            fill="url(#colorRev)" 
                            name="Revenue Curve" 
                          />
                          
                          <ReferenceDot yAxisId="right" x={stats.opt.price} y={1} r={6} fill="#dc2626" stroke="white" strokeWidth={2} />
                          <ReferenceLine yAxisId="right" x={stats.opt.price} stroke="#dc2626" strokeDasharray="3 3" />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                 </div>
               </div>

               <div className="card">
                 <div className="card-header d-flex align-items-center gap-2">
                   <TableIcon size={18} className="text-primary"/> Data Breakdown
                 </div>
                 <div className="table-responsive">
                   <table className="table table-custom table-hover align-middle mb-0">
                     <thead>
                       <tr>
                         <th>Price</th>
                         <th>N</th>
                         <th>Demand</th>
                         {useBoot && <th>Dem Low</th>}
                         {useBoot && <th>Dem High</th>}
                         <th>Revenue</th>
                         {useBoot && <th>Rev Low</th>}
                         {useBoot && <th>Rev High</th>}
                       </tr>
                     </thead>
                     <tbody>
                       {stats.res.map((r, i) => (
                         <tr key={i}>
                           <td className="fw-bold">{effectiveCurrency}{r.price}</td>
                           <td>{r.n_rows}</td>
                           <td>{formatNumber(r.demand * 100, 1)}%</td>
                           {useBoot && <td className="text-muted">{formatNumber(r.demand_lo ? r.demand_lo * 100 : 0, 1)}%</td>}
                           {useBoot && <td className="text-muted">{formatNumber(r.demand_hi ? r.demand_hi * 100 : 0, 1)}%</td>}
                           <td className="text-success fw-bold">{effectiveCurrency}{formatNumber(r.revenue)}</td>
                           {useBoot && <td className="text-muted">{effectiveCurrency}{formatNumber(r.revenue_lo || 0)}</td>}
                           {useBoot && <td className="text-muted">{effectiveCurrency}{formatNumber(r.revenue_hi || 0)}</td>}
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               </div>
             </>
           ) : (
             <div className="card h-100 d-flex justify-content-center align-items-center bg-transparent border-0">
               <div className="text-center p-5 text-muted">
                 <div className="bg-white p-4 rounded-circle shadow-sm d-inline-block mb-3">
                    <Activity size={48} className="text-primary" />
                 </div>
                 <h4>Ready to Analyze</h4>
                 <p>Upload your dataset and configure the mapping on the left to generate insights.</p>
               </div>
             </div>
           )}

           {isBootstrapping && (
             <div className="position-fixed bottom-0 end-0 p-3" style={{zIndex: 1050}}>
               <div className="toast show align-items-center text-white bg-primary border-0 shadow-lg">
                 <div className="d-flex">
                   <div className="toast-body d-flex align-items-center gap-2">
                     <RefreshCw className="animate-spin" size={18} />
                     Running Bootstrap Simulation ({bootB} iterations)...
                   </div>
                 </div>
               </div>
             </div>
           )}
        </div>
      </div>
    </div>
  );
};

export default App;