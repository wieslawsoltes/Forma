"""End-to-end checks. pip install playwright; playwright install chromium.
By default the standalone artifact is tested without network requests. Supply
FORMA_TEST_URL=http://localhost:8080 to include the real origin and IndexedDB.
"""
import asyncio, json, os, zipfile, io
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
RESULTS=[]
async def main():
 async with async_playwright() as p:
  launch={'headless':True,'args':['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--disable-dev-shm-usage']}
  executable=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium')
  if Path(executable).exists(): launch['executable_path']=executable
  browser=await p.chromium.launch(**launch)
  page=await browser.new_page(viewport={'width':1600,'height':1040},device_scale_factor=1)
  page.set_default_timeout(7000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  if os.environ.get('FORMA_TEST_URL'):await page.goto(os.environ['FORMA_TEST_URL'])
  else:await page.set_content((ROOT/'forma.html').read_text(),wait_until='load')
  await page.wait_for_function('window.forma?.ready',timeout=20000)
  await page.wait_for_timeout(200)
  async def check(name,predicate):
   ok=await page.evaluate(predicate)
   RESULTS.append({'test':name,'pass':bool(ok)})
   print(('PASS' if ok else 'FAIL'),name,flush=True)
   if not ok:raise AssertionError(name)
  async def reset():
   await page.evaluate("forma.actions.new(); document.querySelector('#stage').focus()")
   await page.wait_for_timeout(70)
  async def coord(x,y):
   b=await page.locator('#stage').bounding_box()
   return b['x']+x,b['y']+y
  async def draw(key,a,b):
   await page.locator('#stage').focus();await page.keyboard.press(key)
   x,y=await coord(*a);xx,yy=await coord(*b)
   await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(xx,yy,steps=8);await page.mouse.up();await page.wait_for_timeout(80)
  await check('Demo loads 136 editable layers', 'forma.store.index.size===136')
  await check('Initial selection is editable headline',"forma.store.selection()[0].type==='text'")
  await check('Typography font size and opacity controls have usable widths',"[...document.querySelectorAll('input[data-prop=fontSize],input[data-prop=opacityPercent]')].every(e=>e.getBoundingClientRect().width>20)")
  await page.screenshot(path=str(ROOT/'tests'/'light.png'))
  await page.evaluate('forma.actions.theme()');await page.wait_for_timeout(80)
  await check('Dark theme switches tokens',"document.documentElement.dataset.theme==='dark'")
  await page.screenshot(path=str(ROOT/'tests'/'dark.png'))
  await page.evaluate('forma.actions.theme()')
  await reset()
  await draw('r',(120,120),(260,210))
  await check('Rectangle drag creates real geometry',"(()=>{const n=forma.store.selection()[0];return n.type==='rect'&&Math.abs(n.w-140)<1&&Math.abs(n.h-90)<1})()")
  await page.evaluate('window.firstId=forma.store.selection()[0].id')
  # Inspector mutation is a real undoable operation.
  await page.locator('input[data-prop=w]').fill('220');await page.locator('input[data-prop=w]').press('Tab')
  await check('Inspector edits width', 'forma.store.get(firstId).w===220')
  await page.evaluate('forma.actions.undo()')
  await check('Undo restores width', 'forma.store.get(firstId).w===140')
  await page.evaluate('forma.actions.redo()')
  await check('Redo restores edited width', 'forma.store.get(firstId).w===220')
  await page.locator('input[data-prop=fill]').fill('#ED7855');await page.locator('input[data-prop=fill]').press('Tab')
  await check('Hex fill applies',"forma.store.get(firstId).fill==='#ED7855'")
  # Move and snap; no other objects in this document.
  await page.locator('#stage').focus()
  x,y=await coord(170,155);xx,yy=await coord(200,195)
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(xx,yy,steps=6);await page.mouse.up()
  await check('Pointer movement commits coordinates', 'forma.store.get(firstId).x===80&&forma.store.get(firstId).y===90')
  await page.evaluate('forma.actions.duplicate()')
  await check('Duplicate assigns unique identities', 'forma.store.page.nodes.length===2&&new Set(forma.store.page.nodes.map(n=>n.id)).size===2')
  await page.evaluate('forma.actions.selectAll();forma.actions.group()')
  await check('Group nests selected layers',"forma.store.page.nodes.length===1&&forma.store.page.nodes[0].type==='group'&&forma.store.page.nodes[0].children.length===2")
  await page.evaluate('forma.actions.ungroup()')
  await check('Ungroup preserves editable children','forma.store.page.nodes.length===2')
  await page.evaluate('forma.actions.union()')
  await check('Boolean union produces compound vector geometry',"forma.store.page.nodes.length===1&&forma.store.page.nodes[0].type==='path'&&forma.store.page.nodes[0].contours.length>0")
  await page.evaluate('forma.actions.undo()')
  await check('Boolean undo preserves operands','forma.store.page.nodes.length===2')
  # Text input and real textarea overlay.
  await reset();await page.keyboard.press('t');x,y=await coord(130,135);await page.mouse.click(x,y)
  await page.locator('#text-editor').fill('Hello Forma\nEditable typography');await page.locator('#text-editor').press('Control+Enter')
  await check('Text editing commits multiline content',"forma.store.selection()[0].text==='Hello Forma\\nEditable typography'&&document.querySelector('#text-editor').hidden")
  await page.evaluate('forma.actions.undo()')
  await check('Text edit is undoable',"forma.store.selection()[0].text==='Your next idea'")
  # Pen drag creates Bezier handles, enter finishes; edit mode supports live points.
  await reset();await page.keyboard.press('p')
  for a,b in [((130,140),None),((250,150),(280,200)),((300,300),None)]:
   x,y=await coord(*a);await page.mouse.move(x,y);await page.mouse.down()
   if b:
    xx,yy=await coord(*b);await page.mouse.move(xx,yy,steps=5)
   await page.mouse.up()
  await page.keyboard.press('Enter')
  await check('Pen preserves editable cubic handles',"(()=>{const n=forma.store.selection()[0];return n.type==='path'&&n.points.length===3&&!!n.points[1].out&&!n.closed})()")
  await page.keyboard.press('Enter')
  await check('Enter opens vector editing', 'forma.vectorId===forma.store.selection()[0].id')
  await page.keyboard.press('Escape')
  # SVG importing takes a bounded sanitized path; scripts must not execute.
  svg=b'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><script>window.svgPwned=true</script><rect x="5" y="5" width="80" height="60" rx="7" fill="#00aa88"/><path d="M0 0C30 70 60 70 100 0" stroke="#333" fill="none"/></svg>'
  await page.locator('#file-input').set_input_files({'name':'fixture.svg','mimeType':'image/svg+xml','buffer':svg});await page.wait_for_timeout(160)
  await check('SVG imports editable geometry and removes script',"forma.store.selection()[0].children.length===2&&!window.svgPwned")
  # PNG source round trip and SVG export payloads.
  await check('SVG export serializes vector paths',"forma.exportSVG(forma.exportNodes(forma.store,true),forma.store.bounds()).includes('<path')")
  png=await page.evaluate("async()=>{const b=await forma.exportPNG(forma.exportNodes(forma.store,true),forma.store.bounds(),2,forma.renderer.images);const im=await createImageBitmap(b);return {type:b.type,w:im.width,h:im.height,size:b.size}}")
  assert png['type']=='image/png' and png['w']>100 and png['size']>100
  RESULTS.append({'test':'PNG export produces decoded 2× raster','pass':True});print('PASS PNG export produces decoded 2× raster',flush=True)
  # Compressed Sketch ZIP fixture, exercising DecompressionStream and mapping.
  sketch_page={'_class':'page','do_objectID':'sketch-page','name':'Imported page','layers':[{'_class':'artboard','do_objectID':'board-id','name':'Fixture board','frame':{'x':0,'y':0,'width':400,'height':300},'hasBackgroundColor':True,'backgroundColor':{'red':1,'green':1,'blue':1,'alpha':1},'layers':[{'_class':'rectangle','do_objectID':'rect-id','name':'Sketch rectangle','frame':{'x':20,'y':30,'width':100,'height':80},'style':{'fills':[{'isEnabled':True,'fillType':0,'color':{'red':1,'green':0.3,'blue':0.1,'alpha':1}}]}}]}]}
  z=io.BytesIO()
  with zipfile.ZipFile(z,'w',zipfile.ZIP_DEFLATED) as archive: archive.writestr('pages/sketch-page.json',json.dumps(sketch_page));archive.writestr('document.json','{}')
  await page.locator('#file-input').set_input_files({'name':'fixture.sketch','mimeType':'application/octet-stream','buffer':z.getvalue()});await page.wait_for_timeout(400)
  await check('Compressed .sketch archive imports a page and editable rectangle',"forma.store.page.name==='Imported page'&&forma.store.get('rect-id').w===100")
  await page.evaluate('forma.actions.closeModal()')
  # Native save/open equivalent: import exact serialized schema.
  doc=await page.evaluate('JSON.stringify(forma.store.doc)')
  await page.locator('#file-input').set_input_files({'name':'roundtrip.forma','mimeType':'application/json','buffer':doc.encode()});await page.wait_for_timeout(120)
  await check('Native document round trip preserves identities','forma.store.get("rect-id").x===20')
  # Local symbol synchronization and retained overrides.
  await page.evaluate('forma.actions.demo()');await page.wait_for_timeout(80)
  await page.evaluate("(()=>{const m=[...forma.store.index.values()].find(i=>i.node.type==='symbol').node;window.master=m.id;forma.store.transaction('Master edit',()=>m.children[0].fill='#FF0000')})()")
  await check('Master edits synchronize symbol instances',"[...forma.store.index.values()].find(i=>i.node.type==='instance').node.children[0].fill==='#FF0000'")
  # Prototype desktop CTA to phone, then phone back to desktop.
  await page.evaluate('forma.select([forma.store.page.nodes[0].id]);forma.actions.preview()');await page.wait_for_timeout(160)
  await check('Prototype preview opens actual frame',"!document.querySelector('#prototype-view').hidden&&forma.previewId===forma.store.page.nodes[0].id")
  r=await page.locator('#prototype-canvas').bounding_box()
  await page.mouse.click(r['x']+140/1080*r['width'],r['y']+430/820*r['height']);await page.wait_for_timeout(100)
  await check('Clicking real hotspot navigates to mobile frame','forma.previewId===forma.store.page.nodes[1].id')
  await page.evaluate('forma.actions.closePreview()')
  # Command search and responsive surface.
  await page.evaluate('forma.actions.command()');await page.locator('#command-input').fill('oval');await page.locator('#command-input').press('Enter')
  await check('Command palette executes tool command',"forma.tool==='ellipse'")
  await page.evaluate('forma.actions.demo();forma.select([])');await page.wait_for_timeout(150)
  await page.screenshot(path=str(ROOT/'tests'/'desktop.png'))
  await page.set_viewport_size({'width':390,'height':844});await page.wait_for_timeout(150)
  await page.evaluate('forma.actions.fitAll()');await page.wait_for_timeout(120)
  await check('Responsive editor fits mobile viewport','document.documentElement.scrollWidth===390')
  await check('Mobile canvas retains a real drawable area',"document.querySelector('#stage').getBoundingClientRect().width>380&&document.querySelector('#stage').getBoundingClientRect().height>500")
  await page.locator('.mobile-layers-toggle').click()
  await check('Mobile layer drawer is accessible',"getComputedStyle(document.querySelector('.left-sidebar')).display==='flex'")
  await page.locator('.mobile-layers-toggle').click()
  await page.locator('.mobile-inspector-toggle').click()
  await check('Mobile properties drawer is accessible',"getComputedStyle(document.querySelector('.right-sidebar')).display==='flex'")
  await page.locator('.mobile-inspector-toggle').click()
  await page.wait_for_timeout(2200)
  await page.screenshot(path=str(ROOT/'tests'/'mobile.png'))
  await check('No uncaught browser errors','true')
  assert not errors,errors
  print('ERRORS',errors)
  print('METRICS',json.dumps(await page.evaluate('forma.renderer.metrics')))
  (ROOT/'tests'/'browser-results.json').write_text(json.dumps({'tests':RESULTS,'errors':errors,'backend':await page.evaluate('forma.renderer.mode'),'originTested':bool(os.environ.get('FORMA_TEST_URL'))},indent=2))
  await browser.close()
asyncio.run(main())
