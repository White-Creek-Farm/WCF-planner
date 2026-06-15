// Phase 2 Round 4 extraction (verbatim).
import React from 'react';

const FeedCostsPanel = ({feedCosts, saveFeedCosts}) => {
  const {useState, useEffect} = React;
  const [local, setLocal] = useState({starter: 0, grower: 0, layer: 0, pig: 0, grit: 0, ...feedCosts});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLocal({starter: 0, grower: 0, layer: 0, pig: 0, grit: 0, ...feedCosts});
  }, [feedCosts.starter, feedCosts.grower, feedCosts.layer, feedCosts.pig, feedCosts.grit]);

  async function doSave() {
    await saveFeedCosts(local);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const fields = [
    {key: 'starter', label: 'Poultry Starter', icon: '\ud83d\udc14', color: '#a16207'},
    {key: 'grower', label: 'Poultry Grower', icon: '\ud83d\udc14', color: '#085041'},
    {key: 'layer', label: 'Layer Feed', icon: '\ud83d\udc13', color: '#78350f'},
    {key: 'pig', label: 'Pig Feed', icon: '\ud83d\udc37', color: '#1e40af'},
    {key: 'grit', label: 'Grit', icon: '\ud83c\udf3e', color: '#78350f'},
  ];

  return (
    <div style={{marginTop: 8}}>
      <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '20px'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4}}>
          <div>
            <div style={{fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 2}}>Feed Costs</div>
            <div style={{fontSize: 12, color: 'var(--ink-muted)'}}>
              Set the cost per pound for each feed type. Active batches update automatically. Retired and processed
              batches keep their locked price.
            </div>
          </div>
        </div>
        <div style={{height: 1, background: 'var(--border)', margin: '14px 0'}} />
        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 18}}>
          {fields.map(({key, label, icon, color}) => (
            <div key={key}>
              <label style={{fontSize: 12, fontWeight: 600, color, display: 'block', marginBottom: 5}}>
                {icon + ' ' + label}
              </label>
              <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                <span style={{fontSize: 13, color: 'var(--ink-muted)'}}>$</span>
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={local[key] || ''}
                  onChange={(e) => setLocal((c) => ({...c, [key]: e.target.value}))}
                  placeholder="0.000"
                  style={inpS}
                />
                <span style={{fontSize: 12, color: 'var(--ink-faint)', whiteSpace: 'nowrap'}}>/lb</span>
              </div>
              {local[key] > 0 && (
                <div style={{fontSize: 11, color: 'var(--ink-muted)', marginTop: 3}}>
                  ${(local[key] * 100).toFixed(2)} per 100 lbs
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
          <button
            onClick={doSave}
            style={{
              padding: '9px 24px',
              borderRadius: 7,
              border: 'none',
              background: '#085041',
              color: 'white',
              fontWeight: 600,
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {saved ? '\u2713 Saved!' : 'Save Feed Costs'}
          </button>
          {saved && <span style={{fontSize: 12, color: '#065f46', fontWeight: 500}}>Active batches updated.</span>}
        </div>
        <div
          style={{
            marginTop: 16,
            padding: '10px 14px',
            background: 'var(--surface-2)',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--ink-muted)',
          }}
        >
          <strong style={{color: 'var(--ink)'}}>Current prices:</strong>{' '}
          {fields.map(({key, label}) => label + ': $' + (feedCosts[key] || 0).toFixed(3) + '/lb').join(' \u00b7 ')}
        </div>
      </div>
    </div>
  );
};

export default FeedCostsPanel;
