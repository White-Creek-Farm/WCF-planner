import InlineNotice from './InlineNotice.jsx';
import {RecordBackLink, RecordPageBody, RecordPageFrame} from './RecordPageShell.jsx';
import {recordSecondaryButton} from './recordPageControls.jsx';

// Standard fail-closed load-error state for record pages. Pages still own the
// loadError value and retry function; this only centralizes the repeated
// frame/body/back/notice/retry chrome.
export default function RecordPageLoadError({
  Header,
  backLabel,
  onBack,
  notice,
  onRetry,
  maxWidth = 800,
  retryLabel = 'Retry',
  ...bodyProps
}) {
  return (
    <RecordPageFrame Header={Header}>
      <RecordPageBody maxWidth={maxWidth} {...bodyProps}>
        <RecordBackLink label={backLabel} onBack={onBack} />
        <InlineNotice notice={notice} />
        <button type="button" onClick={onRetry} style={{...recordSecondaryButton, marginTop: 10}}>
          {retryLabel}
        </button>
      </RecordPageBody>
    </RecordPageFrame>
  );
}
