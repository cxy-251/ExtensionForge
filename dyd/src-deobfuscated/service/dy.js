'use strict';
const {
  Service
}=require("ee-core"),{
  app,dialog,BrowserWindow,session
}=require("electron"),axios=require("axios"),common=require("../common"),path=require("path"),fs=require('fs'),{
  download
}=require("electron-dl"),Services=require("ee-core/services"),Addon=require("ee-core/addon");
class DyService extends Service{
  constructor(_0x2ceef6){
    super(_0x2ceef6),this.isInterrupt=![],this.headers=[],this.tasks=[];
  }async.openCollectionWindow(_0x418801){
    if(!_0x418801.doNotClear)this.tasks=[];
    Services.get("collection").setListener({
      'urlInterceptor':async _0x19ced9=>{
        if(_0x19ced9.includes("com/note/"))return _0x19ced9.replaceAll("com/note/","com/video/");
        if(_0x418801.type==="solo"&&_0x19ced9.includes("modal_id=")){
          const _0x37f4a1=_0x19ced9.match(/modal_id=(\d+)/);
          if(_0x37f4a1&&_0x37f4a1[1])return "https://www.douyin.com/video/"+_0x37f4a1[1];
        }return _0x19ced9;
      },'onBeforeSendHeaders':(_0x32a8e3,_0x29cf91)=>{
        new Promise(async _0x1e67b9=>{
          if(_0x418801.type==="home"&&_0x29cf91.url.includes("aweme/post")||_0x418801.type==="collection"&&_0x29cf91.url.includes("mix/aweme")||_0x418801.type==="like"&&_0x29cf91.url.includes("aweme/favorite"))for(let _0x3dcf2f=0;
          _0x3dcf2f<5;
          _0x3dcf2f++){
            try{
              delete _0x29cf91.requestHeaders["Accept-Encoding"],this.headers=_0x29cf91.requestHeaders;
              const _0x1b0e01=await axios.get(_0x29cf91.url,{
                'responseType':"json",'headers':_0x29cf91.requestHeaders
              });
              _0x1b0e01.data.aweme_list.forEach(_0x1319d4=>{
                this.handleAweme(_0x1319d4);
              });
              break;
            }catch(_0x306574){
            }await common.sleep(1000);
          }else{
            if(_0x418801.type==="solo"&&_0x29cf91.url.includes("aweme/detail"))for(let _0x2f2588=0;
            _0x2f2588<5;
            _0x2f2588++){
              try{
                delete _0x29cf91.requestHeaders["Accept-Encoding"];
                const _0x48a4c5=await axios.get(_0x29cf91.url,{
                  'responseType':"json",'headers':_0x29cf91.requestHeaders
                });
                this.handleAweme(_0x48a4c5.data.aweme_detail);
                break;
              }catch(_0xbbcaf0){
              }await common.sleep(1000);
            }else{
              if(_0x418801.type==="collec"&&_0x29cf91.url.includes("aweme/listcollection"))for(let _0x3fd166=0;
              _0x3fd166<5;
              _0x3fd166++){
                try{
                  delete _0x29cf91.requestHeaders["Accept-Encoding"],this.headers=_0x29cf91.requestHeaders;
                  const _0x7863ac=await axios.post(_0x29cf91.url,_0x29cf91.uploadData[0].bytes.toString(),{
                    'headers':_0x29cf91.requestHeaders,'timeout':10000
                  });
                  _0x7863ac.data.aweme_list.forEach(_0x32923b=>{
                    this.handleAweme(_0x32923b);
                  });
                  break;
                }catch(_0x35b443){
                }await common.sleep(1000);
              }
            }
          }_0x1e67b9();
        });
      },'onDidFinishLoad':_0x373455=>{
        _0x373455.webContents.executeJavaScript("\n                      const div1 = document.createElement('div');\n                      div1.id = 'dydTip1';\n                      div1.style.position = 'fixed';\n                      div1.style.top = '10px';\n                      div1.style.left = '10px';\n                      div1.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div1.style.color = 'red';\n                      div1.style.fontWeight = 'bold';\n                      div1.style.fontSize = '20px';\n                      div1.style.zIndex = '999999';\n                      div1.textContent = '请登录抖音，未登录只能采集前20个作品(已登录请忽略)';\n                      document.body.appendChild(div1);\n                      const div2 = document.createElement('div');\n                      div2.id = 'dydTip2';\n                      div2.style.position = 'fixed';\n                      div2.style.top = '40px';\n                      div2.style.left = '10px';\n                      div2.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div2.style.color = 'blue';\n                      div2.style.fontWeight = 'bold';\n                      div2.style.fontSize = '20px';\n                      div2.style.zIndex = '999999';\n                      div2.textContent = '如果弹出验证码请手动完成验证否则无法采集作品';\n                      document.body.appendChild(div2);\n                      const div3 = document.createElement('div');\n                      div3.id = 'dydTip3';\n                      div3.style.position = 'fixed';\n                      div3.style.top = '80px';\n                      div3.style.left = '10px';\n                      div3.style.background = 'rgba(0, 0, 0, 0.5)';\n                      div3.style.color = 'yellow';\n                      div3.style.fontWeight = 'bold';\n                      div3.style.fontSize = '20px';\n                      div3.style.zIndex = '999999';\n                      div3.textContent = '点击我关闭提示';\n                      document.body.appendChild(div3);\n                      dydTip3.addEventListener('click', () => {\n                         div1.remove();\n                         div2.remove();\n                         div3.remove();\n                      });\n                ");
      }
    }),Services.get("collection").open(_0x418801.url);
  }async.downloadI(_0x46826d){
    if(!this.tasks[_0x46826d.task['id']]||this.tasks[_0x46826d.task['id']].urls.length===0){
      common.noticeDownloadProgress(this.app,_0x46826d,-999);
      return;
    }_0x46826d.task.title=this.tasks[_0x46826d.task['id']].title,common.prepare(_0x46826d,'dy'),Addon.get("axDownloader").download(this.tasks[_0x46826d.task['id']].urls,{
      'outDir':_0x46826d.outDir,'skipDownloaded':!![],'nameFactory':_0x3bb721=>{
        return _0x46826d.settings.imageUseTit?_0x46826d.filterFileName+_0x3bb721+".jpg":_0x3bb721+".jpg";
      },'onProgress':_0x2790af=>{
        common.noticeDownloadProgress(this.app,_0x46826d,_0x2790af.rate,null);
      }
    }).then(_0x368030=>{
      common.noticeDownloadProgress(this.app,_0x46826d,100,_0x368030.outDir);
    }).catch(_0x1bf6fe=>{
      common.noticeDownloadProgress(this.app,_0x46826d,-999);
    });
  }async.downloadV(_0x1eb435){
    let _0x39bda3=this.tasks[_0x1eb435.task['id']].urls.length>0?this.tasks[_0x1eb435.task['id']].urls.splice(0,1)[0]:null;
    if(!_0x39bda3){
      let _0x374e65=this.tasks[_0x1eb435.task['id']].uris.length>0?this.tasks[_0x1eb435.task['id']].uris.splice(0,1)[0]:null;
      if(_0x374e65)_0x39bda3="https://aweme.snssdk.com/aweme/v1/play/?video_id="+_0x374e65+"&ratio=1080p&line=0";
    }if(!_0x39bda3)return common.noticeDownloadProgress(this.app,_0x1eb435,-999);
    _0x1eb435.task.title=this.tasks[_0x1eb435.task['id']].title,common.prepare(_0x1eb435,'dy');
    if(_0x1eb435.settings.poster)Addon.get("axDownloader").download(this.tasks[_0x1eb435.task['id']].poster,{
      'outPath':_0x1eb435.absolutePath+".jpg",'skipDownloaded':!![]
    });
    fs.existsSync(path.join(_0x1eb435.outDir,_0x1eb435.filterFileName+".mp4"))?common.noticeDownloadProgress(this.app,_0x1eb435,100,path.join(_0x1eb435.outDir,_0x1eb435.filterFileName+".mp4").toString()):download(this.app.mainWindow,_0x39bda3,{
      'directory':_0x1eb435.outDir,'filename':_0x1eb435.filterFileName+".mp4",'onStarted':_0x28a133=>this.downloadItem=_0x28a133,'onProgress':_0x1b0301=>{
        let _0x3e012c=parseInt(_0x1b0301.percent*100);
        common.noticeDownloadProgress(this.app,_0x1eb435,_0x3e012c);
      }
    }).then(_0x58b30a=>{
      common.noticeDownloadProgress(this.app,_0x1eb435,100,_0x58b30a.getSavePath());
    }).catch(async _0x17fd89=>{
      return this.isInterrupt?(this.tasks[_0x1eb435.task['id']].urls.push(_0x39bda3),common.noticeDownloadProgress(this.app,_0x1eb435,-998,null,"下载失败：手动中止")):(_0x1eb435.retryCounter=_0x1eb435.retryCounter||1,common.noticeDownloadProgress(this.app,_0x1eb435,_0x1eb435.retryCounter++),this.downloadV(_0x1eb435));
    });
  }async.interruptDownload(_0x2bfc3a){
    try{
      this.isInterrupt=_0x2bfc3a.state,this.isInterrupt&&(Addon.get("axDownloader").cancel(),this.downloadItem.cancel());
    }catch(_0x34712e){
    }
  }.handleAweme(_0x4ca0fd){
    try{
      const _0x59a790=common.pkgTask(_0x4ca0fd.video.duration?"video":"images",_0x4ca0fd.aweme_id,_0x4ca0fd.preview_title||_0x4ca0fd.desc,_0x4ca0fd.author.nickname,_0x4ca0fd.statistics.digg_count,_0x4ca0fd.statistics.comment_count,_0x4ca0fd.statistics.share_count,_0x4ca0fd.create_time);
      this.tasks[_0x59a790['id']]={
        'pool':new Set(),'title':_0x59a790.title,'poster':void 0,'uris':[],'urls':[]
      },_0x59a790.title=_0x59a790.title.length>=50?_0x59a790.title.substring(0,50):_0x59a790.title,_0x4ca0fd.video.duration?(this.tasks[_0x59a790['id']].poster=_0x4ca0fd.video.cover.url_list[0],_0x4ca0fd.video.bit_rate.forEach(_0x4b6ce3=>{
        !this.tasks[_0x59a790['id']].pool.has(_0x4b6ce3.play_addr.uri)&&(this.tasks[_0x59a790['id']].pool.add(_0x4b6ce3.play_addr.uri),this.tasks[_0x59a790['id']].uris.push(_0x4b6ce3.play_addr.uri)),this.tasks[_0x59a790['id']].urls.push(..._0x4b6ce3.play_addr.url_list);
      })):this.tasks[_0x59a790['id']].urls=_0x4ca0fd.images.map(_0x2804ed=>_0x2804ed.url_list[0]),common.noticeCollectedTask(this.app,_0x59a790);
    }catch(_0xb1e856){
      console.log(_0xb1e856);
    }
  }
}DyService.toString=()=>"[class DyService]",module.exports=DyService;
