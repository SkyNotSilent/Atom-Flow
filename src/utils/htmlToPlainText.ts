const NON_CONTENT_SELECTOR = 'script,style,template,noscript,iframe,object,embed,svg,math';
const TEXT_BOUNDARY_SELECTOR = 'address,article,aside,blockquote,br,div,dl,dt,dd,figcaption,figure,footer,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,td,th,tr,ul';

export const htmlToPlainText = (value: string): string => {
  if (!value) return '';
  const Parser = globalThis.DOMParser || globalThis.document?.defaultView?.DOMParser;
  if (!Parser) return '';
  const document = new Parser().parseFromString(value, 'text/html');
  document.querySelectorAll(NON_CONTENT_SELECTOR).forEach(element => element.remove());
  document.querySelectorAll(TEXT_BOUNDARY_SELECTOR).forEach(element => {
    element.after(document.createTextNode(' '));
  });
  return (document.body.textContent || '').replace(/\s+/g, ' ').trim();
};
