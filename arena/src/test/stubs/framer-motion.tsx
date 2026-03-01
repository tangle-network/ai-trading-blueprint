import React from 'react';

export const m = {
  div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
};
export const AnimatePresence = ({ children }: any) => <>{children}</>;
