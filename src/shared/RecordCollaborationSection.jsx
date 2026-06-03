import React from 'react';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import CommentsSection from './CommentsSection.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import RecordActivityLog from './RecordActivityLog.jsx';

export default function RecordCollaborationSection({
  sb,
  authState,
  entityType,
  entityId,
  entityLabel,
  spacing = 16,
  showComments = true,
}) {
  return (
    <>
      {showComments && (
        <div data-record-collaboration-section="1" style={{marginTop: spacing}}>
          <CommentsSection
            sb={sb}
            authState={authState}
            entityType={entityType}
            entityId={entityId}
            entityLabel={entityLabel}
          />
        </div>
      )}
      <div style={{marginTop: spacing}}>
        <RecordActivityLog sb={sb} entityType={entityType} entityId={entityId} />
      </div>
    </>
  );
}
