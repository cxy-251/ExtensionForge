'use strict';
const {
  Service
}=require("ee-core"),{
  app,dialog,BrowserWindow,session
}=require("electron"),axios=require("axios"),common=require("../common"),path=require("path"),fs=require('fs'),{
  download
}=require("electron-dl"),Services=require("ee-core/services"),Addon=require("ee-core/addon"),{
  HttpsProxyAgent
}=require("https-proxy-agent");
class TkService extends Service{
  constructor(_0x248740){
    super(_0x248740),this.isInterrupt=![],this.headers=[],this.tasks=[];
  }async.openCollectionWindow(_0x78c00b){
    this.tasks=[],Services.get("collection").setListener({
      'onBeforeSendHeaders':(_0x15ba85,_0x4059dc)=>{
        if(!_0x78c00b.settings||!_0x78c00b.settings.proxy||!_0x78c00b.settings.proxy.enable)return;
        new Promise(async _0x3f79d0=>{
          if(_0x78c00b.type==="home"&&_0x4059dc.url.includes("post/item_list"))for(let _0x587dcb=0;
          _0x587dcb<5;
          _0x587dcb++){
            try{
              delete _0x4059dc.requestHeaders["Accept-Encoding"],this.headers=_0x4059dc.requestHeaders;
              const _0x20a983=await axios.get(_0x4059dc.url,{
                'responseType':"json",'timeout':15000,'headers':_0x4059dc.requestHeaders,'httpAgent':new HttpsProxyAgent("http://"+_0x78c00b.settings.proxy.host+':'+_0x78c00b.settings.proxy.port),'httpsAgent':new HttpsProxyAgent("http://"+_0x78c00b.settings.proxy.host+':'+_0x78c00b.settings.proxy.port)
              });
              _0x20a983.data.itemList.forEach(_0x3aa5b7=>{
                this.handleAweme(_0x3aa5b7);
              });
              break;
            }catch(_0x526fc7){
            }await common.sleep(1000);
          }else{
            if(_0x78c00b.type==="solo"&&_0x4059dc.url.includes("www.tiktok.com")&&_0x4059dc.url.includes('@')){
              this.headers=_0x4059dc.requestHeaders;
              for(let _0x248802=0;
              _0x248802<10;
              _0x248802++){
                try{
                  const _0x1abb7d=await _0x15ba85.webContents.executeJavaScript("\n                                    function getTest() {\n                                        var scriptTag = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');\n                                        var jsonData = scriptTag.innerHTML;\n                                        var data = JSON.parse(jsonData);\n                                        return JSON.stringify(data.__DEFAULT_SCOPE__[\"webapp.video-detail\"].itemInfo.itemStruct);\n                                    }\n                                    getTest();\n                                ");
                  if(_0x1abb7d){
                    const _0x507b52=JSON.parse(_0x1abb7d);
                    this.handleAweme(_0x507b52);
                  }break;
                }catch(_0x55e9b1){
                  console.log(_0x55e9b1);
                }await common.sleep(1000);
              }
            }
          }_0x3f79d0();
        });
      },'onDidFinishLoad':_0x2191c0=>{
        _0x2191c0.webContents.executeJavaScript("\n                      const div1 = document.createElement('div');\n                      div1.id = 'dydTip1';\n                      div1.style.position = 'fixed';\n                      div1.style.top = '10px';\n                      div1.style.left = '10px';\n                      div1.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div1.style.color = 'red';\n                      div1.style.fontWeight = 'bold';\n                      div1.style.fontSize = '20px';\n                      div1.style.zIndex = '999999';\n                      div1.textContent = '请登录Tiktok，未登录只能采集前20个作品(已登录请忽略)';\n                      document.body.appendChild(div1);\n                      const div2 = document.createElement('div');\n                      div2.id = 'dydTip2';\n                      div2.style.position = 'fixed';\n                      div2.style.top = '40px';\n                      div2.style.left = '10px';\n                      div2.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div2.style.color = 'blue';\n                      div2.style.fontWeight = 'bold';\n                      div2.style.fontSize = '20px';\n                      div2.style.zIndex = '999999';\n                      div2.textContent = '如果弹出验证码请手动完成验证否则无法采集作品';\n                      document.body.appendChild(div2);\n                      const div3 = document.createElement('div');\n                      div3.id = 'myDiv';\n                      div3.style.position = 'fixed';\n                      div3.style.top = '80px';\n                      div3.style.left = '10px';\n                      div3.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div3.style.color = 'yellow';\n                      div3.style.fontWeight = 'bold';\n                      div3.style.fontSize = '20px';\n                      div3.style.zIndex = '999999';\n                      div3.textContent = '在采集数据之前，需要先在设置中配置代理，并确保其已开启';\n                      document.body.appendChild(div3);\n                      const div4 = document.createElement('div');\n                      div4.id = 'dydTip4';\n                      div4.style.position = 'fixed';\n                      div4.style.top = '150px';\n                      div4.style.left = '10px';\n                      div4.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div4.style.color = 'yellow';\n                      div4.style.fontWeight = 'bold';\n                      div4.style.fontSize = '20px';\n                      div4.style.zIndex = '999999';\n                      div4.textContent = '点击我关闭提示';\n                      document.body.appendChild(div4);\n                      dydTip4.addEventListener('click', () => {\n                         div1.remove();\n                         div2.remove();\n                         div3.remove();\n                         div4.remove();\n                      });\n                ");
      }
    }),Services.get("collection").open(_0x78c00b.url);
  }async.downloadV(_0xf4dab8){
    let _0x21b406=this.tasks[_0xf4dab8.task['id']].urls.length>0?this.tasks[_0xf4dab8.task['id']].urls.splice(0,1)[0]:null;
    if(!_0x21b406)return common.noticeDownloadProgress(this.app,_0xf4dab8,-999);
    _0xf4dab8.task.title=this.tasks[_0xf4dab8.task['id']].title,common.prepare(_0xf4dab8,'tk');
    if(_0xf4dab8.settings.poster)Addon.get("axDownloader").download(this.tasks[_0xf4dab8.task['id']].poster,{
      'outPath':_0xf4dab8.absolutePath+".jpg",'skipDownloaded':!![],'proxy':_0xf4dab8.settings.proxy
    });
    Addon.get("axDownloader").download(_0x21b406,{
      'outPath':_0xf4dab8.absolutePath,'skipDownloaded':!![],'proxy':_0xf4dab8.settings.proxy,'headers':{
        'Cookie':this.headers.Cookie,'Referer':"https://www.tiktok.com/"
      },'onProgress':_0x196954=>{
        common.noticeDownloadProgress(this.app,_0xf4dab8,_0x196954.rate);
      }
    }).then(_0x2212c1=>{
      common.noticeDownloadProgress(this.app,_0xf4dab8,100,_0x2212c1.outPath);
    }).catch(_0x5bd337=>{
      return this.isInterrupt?(this.tasks[_0xf4dab8.task['id']].urls.push(_0x21b406),common.noticeDownloadProgress(this.app,_0xf4dab8,-998,null,"下载失败：手动中止")):(_0xf4dab8.retryCounter=_0xf4dab8.retryCounter||1,common.noticeDownloadProgress(this.app,_0xf4dab8,_0xf4dab8.retryCounter++),this.downloadV(_0xf4dab8));
    });
  }async.interruptDownload(_0x4dc69a){
    try{
      this.isInterrupt=_0x4dc69a.state,this.isInterrupt&&(Addon.get("axDownloader").cancel(),this.downloadItem.cancel());
    }catch(_0x3ba5f4){
    }
  }.handleAweme(_0x5ad8eb){
    if(!_0x5ad8eb.video.duration)return;
    try{
      const _0x222e38=common.pkgTask(_0x5ad8eb.video.duration?"video":"images",_0x5ad8eb['id'],_0x5ad8eb.desc,_0x5ad8eb.author.nickname,_0x5ad8eb.stats.diggCount,_0x5ad8eb.stats.commentCount,_0x5ad8eb.stats.shareCount,_0x5ad8eb.createTime);
      _0x222e38.uniqueId=_0x5ad8eb.author.uniqueId,this.tasks[_0x222e38['id']]={
        'title':_0x222e38.title,'poster':void 0,'urls':[]
      },_0x222e38.title=_0x222e38.title.length>=50?_0x222e38.title.substring(0,50):_0x222e38.title;
      if(_0x5ad8eb.video.duration)this.tasks[_0x222e38['id']].poster=_0x5ad8eb.video.cover,_0x5ad8eb.video.bitrateInfo.forEach(_0x55a2a6=>{
        this.tasks[_0x222e38['id']].urls.push(..._0x55a2a6.PlayAddr.UrlList);
      });
      else{
      }common.noticeCollectedTask(this.app,_0x222e38);
    }catch(_0x34f3af){
      console.log(_0x34f3af);
    }
  }
}function _0x53d5(_0x3b9b57,_0x2ace77){
  const _0x434cd2=_0x434c();
  return _0x53d5=function(_0x53d5f8,_0x1e7791){
    _0x53d5f8=_0x53d5f8-321;
    let _0x3d4db8=_0x434cd2[_0x53d5f8];
    return _0x3d4db8;
  },_0x53d5(_0x3b9b57,_0x2ace77);
}TkService.toString=()=>"[class TkService]",module.exports=TkService;
